#![cfg_attr(not(any(feature = "abi-gen", test)), no_main, no_std)]

#[cfg(any(feature = "abi-gen", test))]
extern crate alloc;

use pvm_contract_types::Bytes;
use ruint::aliases::U256;

#[cfg(test)]
#[path = "covered_call_mock_api.rs"]
mod mock_api;

/// CoveredCall — covered call options backed by ERC20 collateral.
/// Uses the asset-conversion precompile for in-the-money price checks.
///
/// # Production TODOs
///
/// Security:
/// - [ ] Formal audit
/// - [ ] Storage error handling — reads silently return defaults; should distinguish "key not
///   found" from unexpected storage errors (as done in VersionRegistry)
/// - [ ] DEX quote manipulation — spot price can be skewed by large swaps before exercise and
///   reversed after. Consider TWAP oracle or minimum hold period
///
/// Features:
/// - [ ] freeze_token — currently pulls tokens into the contract; replace with pallet-assets freeze
///   precompile once available so collateral stays in writer's account
/// - [ ] Protocol fee mechanism
/// - [ ] Partial exercise support
/// - [ ] delistOption e2e test coverage
///
/// Efficiency:
/// - [ ] Pack option data into fewer storage slots (currently 11 per option)
///
/// Operational:
/// - [ ] Event indexer for building the orderbook off-chain
/// - [ ] VersionRegistry integration on the frontend for contract address discovery
/// - [ ] Upgrade/migration strategy — contract is immutable once deployed
///
/// Edge cases:
/// - [ ] Block timestamp manipulation — producers can skew within ~6s bounds; risky for very
///   short-lived options
/// - [ ] Writer can drain DEX pool to force OTM, let option expire, then reverse
#[cfg_attr(
	not(test),
	pvm_contract_macros::contract("CoveredCall.sol", allocator = "bump", allocator_size = 8192)
)]
mod covered_call {
	#[cfg(test)]
	use super::mock_api::MockApi as api;
	use super::*;
	use alloc::vec;
	#[cfg(not(test))]
	use pallet_revive_uapi::{CallFlags, HostFn, HostFnImpl as api, ReturnFlags, StorageFlags};
	#[cfg(test)]
	use pallet_revive_uapi::{CallFlags, ReturnFlags, StorageFlags};

	// ── Constants ────────────────────────────────────────────────────────

	/// Asset-conversion precompile (ADDRESS = 0x0420).
	const PRECOMPILE: [u8; 20] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x04, 0x20, 0, 0];

	/// ERC20 precompile prefix bytes at [16..18] (InlineIdConfig<0x0120>).
	const ERC20_BYTE16: u8 = 0x01;
	const ERC20_BYTE17: u8 = 0x20;

	// Storage tags for per-option slots.
	const TAG_WRITER: u8 = 0x00;
	const TAG_UNDERLYING: u8 = 0x01;
	const TAG_STRIKE_ASSET: u8 = 0x02;
	const TAG_AMOUNT: u8 = 0x03;
	const TAG_STRIKE: u8 = 0x04;
	const TAG_EXPIRY: u8 = 0x05;
	const TAG_STATUS: u8 = 0x06;
	const TAG_CREATED: u8 = 0x07;
	const TAG_PREMIUM: u8 = 0x08;
	const TAG_OWNER: u8 = 0x09;
	const TAG_ASK_PRICE: u8 = 0x0A;

	const STATUS_LISTED: u8 = 0;
	const STATUS_ACTIVE: u8 = 1;
	const STATUS_EXERCISED: u8 = 2;
	#[allow(dead_code)] // Matches Solidity ABI; expire clears storage rather than setting status
	const STATUS_EXPIRED: u8 = 3;
	const STATUS_RESALE: u8 = 4;

	/// Global slot for next option ID counter.
	const SLOT_NEXT_ID: [u8; 32] = [0u8; 32];

	// ── Errors ───────────────────────────────────────────────────────────

	#[derive(Debug, Clone, Copy, PartialEq, Eq)]
	#[allow(dead_code)] // Variants match Solidity ABI errors; some are reverted via byte literals in do_call
	pub enum Error {
		PrecompileCallFailed,
		TransferFromFailed,
		OptionNotActive,
		OptionNotListed,
		OptionNotExpired,
		OptionAlreadyExpired,
		NotOptionOwner,
		UnauthorizedCancel,
		OptionNotResale,
		NotInTheMoney,
		InvalidAsset,
		InvalidAmount,
		InvalidStrike,
		InvalidExpiry,
		Overflow,
		UnknownSelector,
	}

	impl AsRef<[u8]> for Error {
		fn as_ref(&self) -> &[u8] {
			match *self {
				Error::PrecompileCallFailed => b"PrecompileCallFailed",
				Error::TransferFromFailed => b"TransferFromFailed",
				Error::OptionNotActive => b"OptionNotActive",
				Error::OptionNotListed => b"OptionNotListed",
				Error::OptionNotExpired => b"OptionNotExpired",
				Error::OptionAlreadyExpired => b"OptionAlreadyExpired",
				Error::NotOptionOwner => b"NotOptionOwner",
				Error::UnauthorizedCancel => b"UnauthorizedCancel",
				Error::OptionNotResale => b"OptionNotResale",
				Error::NotInTheMoney => b"NotInTheMoney",
				Error::InvalidAsset => b"InvalidAsset",
				Error::InvalidAmount => b"InvalidAmount",
				Error::InvalidStrike => b"InvalidStrike",
				Error::InvalidExpiry => b"InvalidExpiry",
				Error::Overflow => b"Overflow",
				Error::UnknownSelector => b"UnknownSelector",
			}
		}
	}

	// ── Constructor ──────────────────────────────────────────────────────

	#[pvm_contract_macros::constructor]
	pub fn new() -> Result<(), Error> {
		Ok(())
	}

	// ── Methods ──────────────────────────────────────────────────────────

	#[pvm_contract_macros::method]
	pub fn write_option(
		underlying: Bytes,
		strike_asset: Bytes,
		amount: U256,
		strike: U256,
		premium: U256,
		expiry: U256,
	) -> Result<U256, Error> {
		if amount == U256::ZERO {
			return Err(Error::InvalidAmount);
		}
		if strike == U256::ZERO {
			return Err(Error::InvalidStrike);
		}
		if erc20_of(&underlying.0).is_none() {
			return Err(Error::InvalidAsset);
		}
		if erc20_of(&strike_asset.0).is_none() {
			return Err(Error::InvalidAsset);
		}
		if underlying.0 == strike_asset.0 {
			return Err(Error::InvalidAsset);
		}
		let amount = to_u128(amount)?;
		let strike = to_u128(strike)?;
		let premium = to_u128(premium)?;
		let current_time = now();
		if expiry <= current_time {
			return Err(Error::InvalidExpiry);
		}

		let caller = caller_addr();
		let me = self_addr();

		// Read and increment counter.
		let option_id = storage_get_u256(&SLOT_NEXT_ID);
		let next_id = option_id.checked_add(U256::from(1)).ok_or(Error::Overflow)?;
		storage_set_u256(&SLOT_NEXT_ID, next_id);

		// Lock collateral from caller.
		freeze_token(&underlying.0, &caller, &me, amount);

		// Store option fields.
		storage_set_addr(&option_slot(option_id, TAG_WRITER), &caller);
		storage_set_bytes(&option_slot(option_id, TAG_UNDERLYING), &underlying.0);
		storage_set_bytes(&option_slot(option_id, TAG_STRIKE_ASSET), &strike_asset.0);
		storage_set_u128(&option_slot(option_id, TAG_AMOUNT), amount);
		storage_set_u128(&option_slot(option_id, TAG_STRIKE), strike);
		storage_set_u128(&option_slot(option_id, TAG_PREMIUM), premium);
		storage_set_u256(&option_slot(option_id, TAG_EXPIRY), expiry);
		storage_set_u256(&option_slot(option_id, TAG_CREATED), current_time);
		storage_set_u256(&option_slot(option_id, TAG_STATUS), U256::from(STATUS_LISTED));

		emit_option_written(option_id, &caller, amount, strike, premium, expiry);
		Ok(option_id)
	}

	#[pvm_contract_macros::method]
	pub fn buy_option(option_id: U256) -> Result<(), Error> {
		// Check option exists and is available (listed or resale).
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));
		if status != U256::from(STATUS_LISTED) && status != U256::from(STATUS_RESALE) {
			return Err(Error::OptionNotListed);
		}
		let writer = storage_get_addr(&option_slot(option_id, TAG_WRITER));
		if writer == [0u8; 20] {
			return Err(Error::OptionNotListed);
		}

		// Check not expired.
		let expiry = storage_get_u256(&option_slot(option_id, TAG_EXPIRY));
		let current_time = now();
		if current_time >= expiry {
			return Err(Error::OptionAlreadyExpired);
		}

		let caller = caller_addr();

		if status == U256::from(STATUS_LISTED) {
			// First sale: pay premium to writer.
			let premium = storage_get_u128(&option_slot(option_id, TAG_PREMIUM));
			if premium > 0 {
				let strike_raw = storage_get_raw(&option_slot(option_id, TAG_STRIKE_ASSET));
				let s_len = asset_byte_len(&strike_raw);
				pull_token(&strike_raw[..s_len], &caller, &writer, premium);
			}
		} else {
			// Resale: pay ask price to current owner.
			let current_owner = storage_get_addr(&option_slot(option_id, TAG_OWNER));
			let ask_price = storage_get_u128(&option_slot(option_id, TAG_ASK_PRICE));
			if ask_price > 0 {
				let strike_raw = storage_get_raw(&option_slot(option_id, TAG_STRIKE_ASSET));
				let s_len = asset_byte_len(&strike_raw);
				pull_token(&strike_raw[..s_len], &caller, &current_owner, ask_price);
			}
			storage_clear(&option_slot(option_id, TAG_ASK_PRICE));
		}

		// Record owner and activate.
		storage_set_addr(&option_slot(option_id, TAG_OWNER), &caller);
		storage_set_u256(&option_slot(option_id, TAG_STATUS), U256::from(STATUS_ACTIVE));

		emit_option_bought(option_id, &caller);
		Ok(())
	}

	#[pvm_contract_macros::method]
	pub fn resell_option(option_id: U256, ask_price: U256) -> Result<(), Error> {
		// Check option is active or already listed for resale (to update ask price).
		let writer = storage_get_addr(&option_slot(option_id, TAG_WRITER));
		if writer == [0u8; 20] {
			return Err(Error::OptionNotActive);
		}
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));
		if !(status == U256::from(STATUS_ACTIVE) || status == U256::from(STATUS_RESALE)) {
			return Err(Error::OptionNotActive);
		}

		// Only the current owner can resell.
		let owner = storage_get_addr(&option_slot(option_id, TAG_OWNER));
		let caller = caller_addr();
		if caller != owner {
			return Err(Error::NotOptionOwner);
		}

		let ask_price = to_u128(ask_price)?;

		// Check not expired.
		let expiry = storage_get_u256(&option_slot(option_id, TAG_EXPIRY));
		let current_time = now();
		if current_time >= expiry {
			return Err(Error::OptionAlreadyExpired);
		}

		// List for resale (or update ask price).
		storage_set_u128(&option_slot(option_id, TAG_ASK_PRICE), ask_price);
		storage_set_u256(&option_slot(option_id, TAG_STATUS), U256::from(STATUS_RESALE));

		emit_option_resale(option_id, &caller, ask_price);
		Ok(())
	}

	#[pvm_contract_macros::method]
	pub fn delist_option(option_id: U256) -> Result<(), Error> {
		// Check option is listed for resale.
		let writer = storage_get_addr(&option_slot(option_id, TAG_WRITER));
		if writer == [0u8; 20] {
			return Err(Error::OptionNotActive);
		}
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));
		if status != U256::from(STATUS_RESALE) {
			return Err(Error::OptionNotResale);
		}

		// Only the current owner can delist.
		let owner = storage_get_addr(&option_slot(option_id, TAG_OWNER));
		let caller = caller_addr();
		if caller != owner {
			return Err(Error::NotOptionOwner);
		}

		// Return to active, clear ask price.
		storage_clear(&option_slot(option_id, TAG_ASK_PRICE));
		storage_set_u256(&option_slot(option_id, TAG_STATUS), U256::from(STATUS_ACTIVE));

		emit_option_delisted(option_id, &caller);
		Ok(())
	}

	#[pvm_contract_macros::method]
	pub fn cancel_option(option_id: U256) -> Result<(), Error> {
		// Check option exists.
		let writer = storage_get_addr(&option_slot(option_id, TAG_WRITER));
		if writer == [0u8; 20] {
			return Err(Error::OptionNotActive);
		}
		// Only listed options can be cancelled — once bought, the writer is committed.
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));
		if status != U256::from(STATUS_LISTED) {
			return Err(Error::OptionNotListed);
		}
		// Only the writer can cancel.
		let caller = caller_addr();
		if caller != writer {
			return Err(Error::UnauthorizedCancel);
		}

		let underlying_raw = storage_get_raw(&option_slot(option_id, TAG_UNDERLYING));
		let amount = storage_get_u128(&option_slot(option_id, TAG_AMOUNT));
		let u_len = asset_byte_len(&underlying_raw);

		// Return collateral to writer.
		push_token(&underlying_raw[..u_len], &writer, amount);

		// Clear storage.
		storage_clear(&option_slot(option_id, TAG_WRITER));
		storage_clear(&option_slot(option_id, TAG_UNDERLYING));
		storage_clear(&option_slot(option_id, TAG_STRIKE_ASSET));
		storage_clear(&option_slot(option_id, TAG_AMOUNT));
		storage_clear(&option_slot(option_id, TAG_STRIKE));
		storage_clear(&option_slot(option_id, TAG_PREMIUM));
		storage_clear(&option_slot(option_id, TAG_EXPIRY));
		storage_clear(&option_slot(option_id, TAG_CREATED));
		storage_clear(&option_slot(option_id, TAG_OWNER));
		storage_clear(&option_slot(option_id, TAG_ASK_PRICE));
		storage_clear(&option_slot(option_id, TAG_STATUS));

		emit_option_cancelled(option_id, &caller);
		Ok(())
	}

	#[pvm_contract_macros::method]
	pub fn exercise_option(option_id: U256) -> Result<(), Error> {
		// Check option exists and is active (bought).
		let writer = storage_get_addr(&option_slot(option_id, TAG_WRITER));
		if writer == [0u8; 20] {
			return Err(Error::OptionNotActive);
		}
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));
		if status != U256::from(STATUS_ACTIVE) {
			return Err(Error::OptionNotActive);
		}

		// Only the owner can exercise.
		let owner = storage_get_addr(&option_slot(option_id, TAG_OWNER));
		let caller = caller_addr();
		if caller != owner {
			return Err(Error::NotOptionOwner);
		}

		// Check not expired.
		let expiry = storage_get_u256(&option_slot(option_id, TAG_EXPIRY));
		let current_time = now();
		if current_time >= expiry {
			return Err(Error::OptionAlreadyExpired);
		}

		// Load option details.
		let underlying_raw = storage_get_raw(&option_slot(option_id, TAG_UNDERLYING));
		let strike_raw = storage_get_raw(&option_slot(option_id, TAG_STRIKE_ASSET));
		let amount = storage_get_u128(&option_slot(option_id, TAG_AMOUNT));
		let strike = storage_get_u128(&option_slot(option_id, TAG_STRIKE));

		let u_len = asset_byte_len(&underlying_raw);
		let s_len = asset_byte_len(&strike_raw);

		// In-the-money check: market value of underlying > strike.
		let market_value = get_dex_quote(&underlying_raw[..u_len], &strike_raw[..s_len], amount);
		if market_value <= U256::from(strike) {
			return Err(Error::NotInTheMoney);
		}

		// Owner pays strike asset directly to writer.
		pull_token(&strike_raw[..s_len], &caller, &writer, strike);

		// Release collateral to owner.
		push_token(&underlying_raw[..u_len], &caller, amount);

		// Mark exercised.
		storage_set_u256(&option_slot(option_id, TAG_STATUS), U256::from(STATUS_EXERCISED));

		emit_option_exercised(option_id, &caller);
		Ok(())
	}

	#[pvm_contract_macros::method]
	pub fn expire_option(option_id: U256) -> Result<(), Error> {
		// Check option exists and is listed or active.
		let writer = storage_get_addr(&option_slot(option_id, TAG_WRITER));
		if writer == [0u8; 20] {
			return Err(Error::OptionNotActive);
		}
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));
		if status != U256::from(STATUS_LISTED) &&
			status != U256::from(STATUS_ACTIVE) &&
			status != U256::from(STATUS_RESALE)
		{
			return Err(Error::OptionNotActive);
		}

		let expiry = storage_get_u256(&option_slot(option_id, TAG_EXPIRY));
		let current_time = now();
		if current_time < expiry {
			return Err(Error::OptionNotExpired);
		}

		let underlying_raw = storage_get_raw(&option_slot(option_id, TAG_UNDERLYING));
		let amount = storage_get_u128(&option_slot(option_id, TAG_AMOUNT));
		let u_len = asset_byte_len(&underlying_raw);

		// Return collateral to writer.
		push_token(&underlying_raw[..u_len], &writer, amount);

		// Clear storage — option is fully settled.
		storage_clear(&option_slot(option_id, TAG_WRITER));
		storage_clear(&option_slot(option_id, TAG_UNDERLYING));
		storage_clear(&option_slot(option_id, TAG_STRIKE_ASSET));
		storage_clear(&option_slot(option_id, TAG_AMOUNT));
		storage_clear(&option_slot(option_id, TAG_STRIKE));
		storage_clear(&option_slot(option_id, TAG_PREMIUM));
		storage_clear(&option_slot(option_id, TAG_EXPIRY));
		storage_clear(&option_slot(option_id, TAG_CREATED));
		storage_clear(&option_slot(option_id, TAG_OWNER));
		storage_clear(&option_slot(option_id, TAG_ASK_PRICE));
		storage_clear(&option_slot(option_id, TAG_STATUS));

		emit_option_expired(option_id, &writer);
		Ok(())
	}

	#[pvm_contract_macros::method]
	pub fn get_option(
		option_id: U256,
	) -> (
		pvm_contract_types::Address,
		Bytes,
		Bytes,
		U256,
		U256,
		U256,
		U256,
		U256,
		pvm_contract_types::Address,
		U256,
		U256,
	) {
		let writer = storage_get_addr(&option_slot(option_id, TAG_WRITER));
		let underlying_raw = storage_get_raw(&option_slot(option_id, TAG_UNDERLYING));
		let strike_raw = storage_get_raw(&option_slot(option_id, TAG_STRIKE_ASSET));
		let amount = U256::from(storage_get_u128(&option_slot(option_id, TAG_AMOUNT)));
		let strike = U256::from(storage_get_u128(&option_slot(option_id, TAG_STRIKE)));
		let premium = U256::from(storage_get_u128(&option_slot(option_id, TAG_PREMIUM)));
		let expiry = storage_get_u256(&option_slot(option_id, TAG_EXPIRY));
		let created = storage_get_u256(&option_slot(option_id, TAG_CREATED));
		let owner = storage_get_addr(&option_slot(option_id, TAG_OWNER));
		let ask_price = U256::from(storage_get_u128(&option_slot(option_id, TAG_ASK_PRICE)));
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));

		let u_len = asset_byte_len(&underlying_raw);
		let s_len = asset_byte_len(&strike_raw);

		(
			pvm_contract_types::Address(writer),
			Bytes(underlying_raw[..u_len].to_vec()),
			Bytes(strike_raw[..s_len].to_vec()),
			amount,
			strike,
			premium,
			expiry,
			created,
			pvm_contract_types::Address(owner),
			ask_price,
			status,
		)
	}

	#[pvm_contract_macros::method]
	pub fn next_option_id() -> U256 {
		storage_get_u256(&SLOT_NEXT_ID)
	}

	#[pvm_contract_macros::fallback]
	pub fn fallback() -> Result<(), Error> {
		Err(Error::UnknownSelector)
	}

	// ── Storage helpers ──────────────────────────────────────────────────

	fn option_slot(id: U256, tag: u8) -> [u8; 32] {
		let mut preimage = [0u8; 33];
		preimage[..32].copy_from_slice(&id.to_be_bytes::<32>());
		preimage[32] = tag;
		let mut hash = [0u8; 32];
		api::hash_keccak_256(&preimage, &mut hash);
		hash
	}

	fn storage_get_u256(key: &[u8; 32]) -> U256 {
		let mut buf = [0u8; 32];
		let mut out = &mut buf[..];
		let _ = api::get_storage(StorageFlags::empty(), key, &mut out);
		U256::from_be_bytes::<32>(buf)
	}

	fn storage_set_u256(key: &[u8; 32], val: U256) {
		api::set_storage(StorageFlags::empty(), key, &val.to_be_bytes::<32>());
	}

	fn storage_get_addr(key: &[u8; 32]) -> [u8; 20] {
		let mut buf = [0u8; 32];
		let mut out = &mut buf[..];
		let _ = api::get_storage(StorageFlags::empty(), key, &mut out);
		let mut addr = [0u8; 20];
		addr.copy_from_slice(&buf[12..32]);
		addr
	}

	fn storage_set_addr(key: &[u8; 32], addr: &[u8; 20]) {
		let mut buf = [0u8; 32];
		buf[12..32].copy_from_slice(addr);
		api::set_storage(StorageFlags::empty(), key, &buf);
	}

	fn storage_get_raw(key: &[u8; 32]) -> [u8; 32] {
		let mut buf = [0u8; 32];
		let mut out = &mut buf[..];
		let _ = api::get_storage(StorageFlags::empty(), key, &mut out);
		buf
	}

	fn storage_set_bytes(key: &[u8; 32], data: &[u8]) {
		let mut buf = [0u8; 32];
		let len = data.len().min(32);
		buf[..len].copy_from_slice(&data[..len]);
		api::set_storage(StorageFlags::empty(), key, &buf);
	}

	/// Checked U256 → u128 cast. AssetHub uses u128 balances.
	fn to_u128(v: U256) -> Result<u128, Error> {
		if v > U256::from(u128::MAX) {
			return Err(Error::Overflow);
		}
		Ok(v.as_limbs()[0] as u128 | (v.as_limbs()[1] as u128) << 64)
	}

	fn storage_get_u128(key: &[u8; 32]) -> u128 {
		let v = storage_get_u256(key);
		// Values were validated on write — truncation is safe.
		v.as_limbs()[0] as u128 | (v.as_limbs()[1] as u128) << 64
	}

	fn storage_set_u128(key: &[u8; 32], val: u128) {
		storage_set_u256(key, U256::from(val));
	}

	fn storage_clear(key: &[u8; 32]) {
		api::set_storage(StorageFlags::empty(), key, &[]);
	}

	/// Determine the byte length of a SCALE-encoded NativeOrWithId.
	fn asset_byte_len(raw: &[u8; 32]) -> usize {
		match raw[0] {
			0x00 => 1,
			0x01 => 5,
			_ => 0,
		}
	}

	fn now() -> U256 {
		let mut buf = [0u8; 32];
		api::now(&mut buf);
		U256::from_le_bytes::<32>(buf)
	}

	// ── DEX quote ────────────────────────────────────────────────────────

	fn get_dex_quote(underlying: &[u8], strike_asset: &[u8], amount: u128) -> U256 {
		let calldata = build_quote_exact_in(underlying, strike_asset, U256::from(amount), true);
		let out = dex_call(&calldata);
		dec_u256(&out)
	}

	fn build_quote_exact_in(a_in: &[u8], a_out: &[u8], amount: U256, fee: bool) -> Vec<u8> {
		let s = sel(b"quoteExactTokensForTokens(bytes,bytes,uint256,bool)");
		enc_two_bytes(&s, a_in, a_out, &[enc_u256(amount), enc_bool(fee)])
	}

	// ── Token management ─────────────────────────────────────────────────

	fn pull_token(asset: &[u8], from: &[u8; 20], to: &[u8; 20], amount: u128) {
		if let Some(erc20) = erc20_of(asset) {
			erc20_call(&erc20, &build_transfer_from(from, to, U256::from(amount)));
		}
	}

	/// Lock collateral for an option. Currently pulls tokens into the contract.
	/// TODO: replace with a freeze precompile call so tokens stay in the
	/// writer's account (requires a pallet-assets freeze precompile).
	fn freeze_token(asset: &[u8], from: &[u8; 20], to: &[u8; 20], amount: u128) {
		pull_token(asset, from, to, amount);
	}

	fn push_token(asset: &[u8], to: &[u8; 20], amount: u128) {
		if let Some(erc20) = erc20_of(asset) {
			erc20_call(&erc20, &build_erc20_transfer(to, U256::from(amount)));
		}
	}

	pub fn erc20_of(asset: &[u8]) -> Option<[u8; 20]> {
		if asset.is_empty() || asset[0] == 0x00 {
			return None;
		}
		if asset[0] == 0x01 && asset.len() >= 5 {
			let id = u32::from_le_bytes([asset[1], asset[2], asset[3], asset[4]]);
			let mut addr = [0u8; 20];
			addr[0..4].copy_from_slice(&id.to_be_bytes());
			addr[16] = ERC20_BYTE16;
			addr[17] = ERC20_BYTE17;
			return Some(addr);
		}
		None
	}

	// ── Low-level helpers ────────────────────────────────────────────────

	fn caller_addr() -> [u8; 20] {
		let mut out = [0u8; 20];
		api::caller(&mut out);
		out
	}

	fn self_addr() -> [u8; 20] {
		let mut out = [0u8; 20];
		api::address(&mut out);
		out
	}

	fn sel(sig: &[u8]) -> [u8; 4] {
		let mut h = [0u8; 32];
		api::hash_keccak_256(sig, &mut h);
		[h[0], h[1], h[2], h[3]]
	}

	fn enc_u256(v: U256) -> [u8; 32] {
		v.to_be_bytes::<32>()
	}

	fn enc_addr(a: &[u8; 20]) -> [u8; 32] {
		let mut w = [0u8; 32];
		w[12..32].copy_from_slice(a);
		w
	}

	fn enc_bool(v: bool) -> [u8; 32] {
		let mut w = [0u8; 32];
		if v {
			w[31] = 1;
		}
		w
	}

	fn dec_u256(d: &[u8]) -> U256 {
		if d.len() < 32 {
			return U256::ZERO;
		}
		U256::from_be_bytes::<32>(d[0..32].try_into().unwrap())
	}

	fn dex_call(calldata: &[u8]) -> [u8; 128] {
		do_call(&PRECOMPILE, calldata, b"PrecompileCallFailed()")
	}

	fn erc20_call(addr: &[u8; 20], calldata: &[u8]) -> [u8; 128] {
		let output = do_call(addr, calldata, b"TransferFromFailed()");
		// ERC20 transfer/transferFrom return bool — revert if false.
		if output[31] == 0 {
			let s = sel(b"TransferFromFailed()");
			api::return_value(ReturnFlags::REVERT, &s);
		}
		output
	}

	fn do_call(addr: &[u8; 20], calldata: &[u8], err_sig: &[u8]) -> [u8; 128] {
		let mut output = [0u8; 128];
		let mut output_ref = &mut output[..];
		let result = api::call(
			CallFlags::empty(),
			addr,
			u64::MAX,
			u64::MAX,
			&[u8::MAX; 32],
			&[0u8; 32],
			calldata,
			Some(&mut output_ref),
		);
		if result.is_err() {
			let s = sel(err_sig);
			api::return_value(ReturnFlags::REVERT, &s);
		}
		output
	}

	// ── ERC20 calldata builders ──────────────────────────────────────────

	fn build_transfer_from(from: &[u8; 20], to: &[u8; 20], amount: U256) -> Vec<u8> {
		let s = sel(b"transferFrom(address,address,uint256)");
		let mut buf = vec![0u8; 4 + 3 * 32];
		buf[0..4].copy_from_slice(&s);
		buf[4..36].copy_from_slice(&enc_addr(from));
		buf[36..68].copy_from_slice(&enc_addr(to));
		buf[68..100].copy_from_slice(&enc_u256(amount));
		buf
	}

	fn build_erc20_transfer(to: &[u8; 20], amount: U256) -> Vec<u8> {
		let s = sel(b"transfer(address,uint256)");
		let mut buf = vec![0u8; 4 + 2 * 32];
		buf[0..4].copy_from_slice(&s);
		buf[4..36].copy_from_slice(&enc_addr(to));
		buf[36..68].copy_from_slice(&enc_u256(amount));
		buf
	}

	/// Encode: selector + two `bytes` params + N static 32-byte words.
	fn enc_two_bytes(sig: &[u8; 4], a1: &[u8], a2: &[u8], static_words: &[[u8; 32]]) -> Vec<u8> {
		let a1_padded = ((a1.len() + 31) / 32) * 32;
		let a2_padded = ((a2.len() + 31) / 32) * 32;
		let tail1 = 32 + a1_padded;
		let tail2 = 32 + a2_padded;
		let n_head = 2 + static_words.len();
		let total = 4 + n_head * 32 + tail1 + tail2;
		let mut buf = vec![0u8; total];

		buf[0..4].copy_from_slice(sig);
		let mut pos = 4;

		let tail_start = n_head * 32;
		let mut off1 = [0u8; 32];
		off1[28..32].copy_from_slice(&(tail_start as u32).to_be_bytes());
		buf[pos..pos + 32].copy_from_slice(&off1);
		pos += 32;

		let mut off2 = [0u8; 32];
		off2[28..32].copy_from_slice(&((tail_start + tail1) as u32).to_be_bytes());
		buf[pos..pos + 32].copy_from_slice(&off2);
		pos += 32;

		for word in static_words {
			buf[pos..pos + 32].copy_from_slice(word);
			pos += 32;
		}

		let mut len1 = [0u8; 32];
		len1[28..32].copy_from_slice(&(a1.len() as u32).to_be_bytes());
		buf[pos..pos + 32].copy_from_slice(&len1);
		pos += 32;
		buf[pos..pos + a1.len()].copy_from_slice(a1);
		pos += a1_padded;

		let mut len2 = [0u8; 32];
		len2[28..32].copy_from_slice(&(a2.len() as u32).to_be_bytes());
		buf[pos..pos + 32].copy_from_slice(&len2);
		pos += 32;
		buf[pos..pos + a2.len()].copy_from_slice(a2);

		buf
	}

	// ── Events ───────────────────────────────────────────────────────────

	fn emit_option_written(
		id: U256,
		writer: &[u8; 20],
		amount: u128,
		strike: u128,
		premium: u128,
		expiry: U256,
	) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(
			b"OptionWritten(uint256,address,uint256,uint256,uint256,uint256)",
			&mut sig,
		);
		let t_id = enc_u256(id);
		let mut t_writer = [0u8; 32];
		t_writer[12..32].copy_from_slice(writer);
		let mut data = [0u8; 128];
		data[0..32].copy_from_slice(&enc_u256(U256::from(amount)));
		data[32..64].copy_from_slice(&enc_u256(U256::from(strike)));
		data[64..96].copy_from_slice(&enc_u256(U256::from(premium)));
		data[96..128].copy_from_slice(&enc_u256(expiry));
		api::deposit_event(&[sig, t_id, t_writer], &data);
	}

	fn emit_option_bought(id: U256, owner: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OptionBought(uint256,address)", &mut sig);
		let t_id = enc_u256(id);
		let mut t_owner = [0u8; 32];
		t_owner[12..32].copy_from_slice(owner);
		api::deposit_event(&[sig, t_id, t_owner], &[]);
	}

	fn emit_option_resale(id: U256, owner: &[u8; 20], ask_price: u128) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OptionResale(uint256,address,uint256)", &mut sig);
		let t_id = enc_u256(id);
		let mut t_owner = [0u8; 32];
		t_owner[12..32].copy_from_slice(owner);
		let data = enc_u256(U256::from(ask_price));
		api::deposit_event(&[sig, t_id, t_owner], &data);
	}

	fn emit_option_exercised(id: U256, owner: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OptionExercised(uint256,address)", &mut sig);
		let t_id = enc_u256(id);
		let mut t_owner = [0u8; 32];
		t_owner[12..32].copy_from_slice(owner);
		api::deposit_event(&[sig, t_id, t_owner], &[]);
	}

	fn emit_option_expired(id: U256, writer: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OptionExpired(uint256,address)", &mut sig);
		let t_id = enc_u256(id);
		let mut t_writer = [0u8; 32];
		t_writer[12..32].copy_from_slice(writer);
		api::deposit_event(&[sig, t_id, t_writer], &[]);
	}

	fn emit_option_cancelled(id: U256, writer: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OptionCancelled(uint256,address)", &mut sig);
		let t_id = enc_u256(id);
		let mut t_writer = [0u8; 32];
		t_writer[12..32].copy_from_slice(writer);
		api::deposit_event(&[sig, t_id, t_writer], &[]);
	}

	fn emit_option_delisted(id: U256, owner: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OptionDelisted(uint256,address)", &mut sig);
		let t_id = enc_u256(id);
		let mut t_owner = [0u8; 32];
		t_owner[12..32].copy_from_slice(owner);
		api::deposit_event(&[sig, t_id, t_owner], &[]);
	}
}

// ── Unit tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::{covered_call::*, mock_api};
	use ruint::aliases::U256;

	fn b(v: Vec<u8>) -> pvm_contract_types::Bytes {
		pvm_contract_types::Bytes(v)
	}

	/// TSTA = NativeOrWithId::WithId(1)
	fn tsta() -> pvm_contract_types::Bytes {
		b(vec![0x01, 1, 0, 0, 0])
	}

	/// TSTB = NativeOrWithId::WithId(2)
	fn tstb() -> pvm_contract_types::Bytes {
		b(vec![0x01, 2, 0, 0, 0])
	}

	fn setup() {
		mock_api::reset();
		// Mock DEX quote returns 1000 for any query.
		mock_api::set_call_output(&U256::from(1000u64).to_be_bytes::<32>());
		mock_api::set_now(10);
	}

	// Helper: write_option with standard args.
	// 100 TSTA collateral, 500 TSTB strike total, 20 premium, expires at t=50.
	fn write_std() -> U256 {
		write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(50u64),
		)
		.unwrap()
	}

	#[test]
	fn write_option_stores_and_returns_id() {
		setup();
		let id = write_std();
		assert_eq!(id, U256::ZERO);
		assert_eq!(next_option_id(), U256::from(1u64));
		// 1 ERC20 transferFrom to pull collateral.
		assert_eq!(mock_api::call_count(), 1);
		assert_eq!(mock_api::event_count(), 1);
	}

	#[test]
	fn write_option_increments_counter() {
		setup();
		let _ = write_std();
		let id = write_option(
			tstb(),
			tsta(),
			U256::from(200u64),
			U256::from(2000u64),
			U256::from(5u64),
			U256::from(60u64),
		);
		assert_eq!(id, Ok(U256::from(1u64)));
		assert_eq!(next_option_id(), U256::from(2u64));
	}

	#[test]
	fn write_option_rejects_zero_amount() {
		setup();
		let result = write_option(
			tsta(),
			tstb(),
			U256::ZERO,
			U256::from(500u64),
			U256::from(20u64),
			U256::from(50u64),
		);
		assert_eq!(result, Err(Error::InvalidAmount));
	}

	#[test]
	fn write_option_rejects_zero_strike() {
		setup();
		let result = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::ZERO,
			U256::from(20u64),
			U256::from(50u64),
		);
		assert_eq!(result, Err(Error::InvalidStrike));
	}

	#[test]
	fn write_option_rejects_past_expiry() {
		setup();
		let result = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(5u64),
		);
		assert_eq!(result, Err(Error::InvalidExpiry));
	}

	#[test]
	fn write_option_rejects_native_asset() {
		setup();
		let native = b(vec![0x00]);
		let result = write_option(
			native,
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(50u64),
		);
		assert_eq!(result, Err(Error::InvalidAsset));
	}

	#[test]
	fn write_option_rejects_same_asset() {
		setup();
		let result = write_option(
			tsta(),
			tsta(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(50u64),
		);
		assert_eq!(result, Err(Error::InvalidAsset));
	}

	#[test]
	fn buy_option_sets_owner_and_status() {
		setup();
		let id = write_std();
		mock_api::reset_counts();

		let result = buy_option(id);
		assert_eq!(result, Ok(()));
		// 1 transferFrom for premium payment + 1 event.
		assert_eq!(mock_api::call_count(), 1);
		assert_eq!(mock_api::event_count(), 1);

		let (_, _, _, _, _, _, _, _, owner, _, status) = get_option(id);
		assert_eq!(owner.0, [0xAA; 20]); // Mock caller.
		assert_eq!(status, U256::from(1u64)); // Active.
	}

	#[test]
	fn buy_option_rejects_already_bought() {
		setup();
		let id = write_std();
		let _ = buy_option(id);

		let result = buy_option(id);
		assert_eq!(result, Err(Error::OptionNotListed));
	}

	#[test]
	fn buy_option_rejects_expired() {
		setup();
		let _ = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(15u64),
		);
		mock_api::set_now(20);

		let result = buy_option(U256::ZERO);
		assert_eq!(result, Err(Error::OptionAlreadyExpired));
	}

	#[test]
	fn buy_option_zero_premium_skips_transfer() {
		setup();
		let id = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::ZERO, // zero premium
			U256::from(50u64),
		)
		.unwrap();
		mock_api::reset_counts();

		let result = buy_option(id);
		assert_eq!(result, Ok(()));
		// No transfer call for zero premium.
		assert_eq!(mock_api::call_count(), 0);
	}

	#[test]
	fn exercise_option_when_in_the_money() {
		setup();
		let id = write_std();
		let _ = buy_option(id);

		mock_api::set_call_output(&U256::from(1000u64).to_be_bytes::<32>());
		mock_api::reset_counts();

		let result = exercise_option(id);
		assert_eq!(result, Ok(()));
		// 1 DEX quote + 1 transferFrom (owner pays writer) + 1 transfer (collateral to owner) = 3.
		assert_eq!(mock_api::call_count(), 3);
		assert_eq!(mock_api::event_count(), 1);
	}

	#[test]
	fn exercise_option_rejects_listed_not_bought() {
		setup();
		let id = write_std();

		let result = exercise_option(id);
		assert_eq!(result, Err(Error::OptionNotActive));
	}

	#[test]
	fn exercise_option_rejects_out_of_the_money() {
		setup();
		let id = write_std();
		let _ = buy_option(id);

		mock_api::set_call_output(&U256::from(400u64).to_be_bytes::<32>());
		mock_api::reset_counts();

		let result = exercise_option(id);
		assert_eq!(result, Err(Error::NotInTheMoney));
	}

	#[test]
	fn exercise_option_rejects_after_expiry() {
		setup();
		let id = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(15u64),
		)
		.unwrap();
		let _ = buy_option(id);
		mock_api::set_now(20);

		let result = exercise_option(id);
		assert_eq!(result, Err(Error::OptionAlreadyExpired));
	}

	#[test]
	fn exercise_option_rejects_already_exercised() {
		setup();
		let id = write_std();
		let _ = buy_option(id);
		mock_api::set_call_output(&U256::from(1000u64).to_be_bytes::<32>());
		let _ = exercise_option(id);

		let result = exercise_option(id);
		assert_eq!(result, Err(Error::OptionNotActive));
	}

	#[test]
	fn expire_listed_option_returns_collateral() {
		setup();
		let _ = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(15u64),
		);
		mock_api::set_now(20);
		mock_api::reset_counts();

		let result = expire_option(U256::ZERO);
		assert_eq!(result, Ok(()));
		assert_eq!(mock_api::call_count(), 1);
		assert_eq!(mock_api::event_count(), 1);
	}

	#[test]
	fn expire_active_option_returns_collateral() {
		setup();
		let id = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(15u64),
		)
		.unwrap();
		let _ = buy_option(id);
		mock_api::set_now(20);
		mock_api::reset_counts();

		let result = expire_option(id);
		assert_eq!(result, Ok(()));
		assert_eq!(mock_api::call_count(), 1);
	}

	#[test]
	fn expire_option_rejects_before_expiry() {
		setup();
		let _ = write_std();
		let result = expire_option(U256::ZERO);
		assert_eq!(result, Err(Error::OptionNotExpired));
	}

	#[test]
	fn expire_option_rejects_already_expired() {
		setup();
		let _ = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(15u64),
		);
		mock_api::set_now(20);
		let _ = expire_option(U256::ZERO);

		let result = expire_option(U256::ZERO);
		assert_eq!(result, Err(Error::OptionNotActive));
	}

	#[test]
	fn get_option_returns_stored_values() {
		setup();
		let _ = write_std();

		let (
			writer,
			underlying,
			strike_asset,
			amount,
			strike,
			premium,
			expiry,
			created,
			owner,
			ask_price,
			status,
		) = get_option(U256::ZERO);
		assert_eq!(writer.0, [0xAA; 20]);
		assert_eq!(underlying.0, vec![0x01, 1, 0, 0, 0]);
		assert_eq!(strike_asset.0, vec![0x01, 2, 0, 0, 0]);
		assert_eq!(amount, U256::from(100u64));
		assert_eq!(strike, U256::from(500u64));
		assert_eq!(premium, U256::from(20u64));
		assert_eq!(expiry, U256::from(50u64));
		assert_eq!(created, U256::from(10u64));
		assert_eq!(owner.0, [0u8; 20]); // No owner yet.
		assert_eq!(ask_price, U256::ZERO);
		assert_eq!(status, U256::ZERO); // Listed.
	}

	#[test]
	fn resell_option_sets_ask_and_status() {
		setup();
		let id = write_std();
		let _ = buy_option(id);
		mock_api::reset_counts();

		let result = resell_option(id, U256::from(50u64));
		assert_eq!(result, Ok(()));
		assert_eq!(mock_api::event_count(), 1);

		let (_, _, _, _, _, _, _, _, _, ask_price, status) = get_option(id);
		assert_eq!(ask_price, U256::from(50u64));
		assert_eq!(status, U256::from(4u64)); // Resale.
	}

	#[test]
	fn resell_option_rejects_if_not_owner() {
		setup();
		let id = write_std();
		// Option is listed, not bought — no owner to resell.
		let result = resell_option(id, U256::from(50u64));
		assert_eq!(result, Err(Error::OptionNotActive));
	}

	#[test]
	fn buy_resale_option() {
		setup();
		let id = write_std();
		let _ = buy_option(id);
		let _ = resell_option(id, U256::from(50u64));
		mock_api::reset_counts();

		// Buy the resale — pays ask price to current owner.
		let result = buy_option(id);
		assert_eq!(result, Ok(()));
		// 1 transferFrom for ask price payment + 1 event.
		assert_eq!(mock_api::call_count(), 1);
		assert_eq!(mock_api::event_count(), 1);

		let (_, _, _, _, _, _, _, _, _, ask_price, status) = get_option(id);
		assert_eq!(status, U256::from(1u64)); // Active again.
		assert_eq!(ask_price, U256::ZERO); // Ask price cleared.
	}

	#[test]
	fn expire_resale_option_returns_collateral() {
		setup();
		let id = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(15u64),
		)
		.unwrap();
		let _ = buy_option(id);
		let _ = resell_option(id, U256::from(50u64));
		mock_api::set_now(20);
		mock_api::reset_counts();

		let result = expire_option(id);
		assert_eq!(result, Ok(()));
		assert_eq!(mock_api::call_count(), 1);
	}

	#[test]
	fn resell_option_updates_ask_price() {
		setup();
		let id = write_std();
		let _ = buy_option(id);
		let _ = resell_option(id, U256::from(50u64));

		// Update ask price while already in Resale status.
		let result = resell_option(id, U256::from(30u64));
		assert_eq!(result, Ok(()));

		let (_, _, _, _, _, _, _, _, _, ask_price, status) = get_option(id);
		assert_eq!(ask_price, U256::from(30u64));
		assert_eq!(status, U256::from(4u64)); // Still Resale.
	}

	#[test]
	fn delist_option_returns_to_active() {
		setup();
		let id = write_std();
		let _ = buy_option(id);
		let _ = resell_option(id, U256::from(50u64));
		mock_api::reset_counts();

		let result = delist_option(id);
		assert_eq!(result, Ok(()));
		assert_eq!(mock_api::event_count(), 1);

		let (_, _, _, _, _, _, _, _, _, ask_price, status) = get_option(id);
		assert_eq!(status, U256::from(1u64)); // Active.
		assert_eq!(ask_price, U256::ZERO); // Cleared.
	}

	#[test]
	fn delist_option_rejects_if_not_resale() {
		setup();
		let id = write_std();
		let _ = buy_option(id);

		// Option is Active, not Resale — delist should fail.
		let result = delist_option(id);
		assert_eq!(result, Err(Error::OptionNotResale));
	}

	#[test]
	fn write_option_checked_add_overflow() {
		setup();
		// Set the option ID counter to U256::MAX so the next write overflows.
		let max = U256::MAX;
		mock_api::set_storage(&[0u8; 32], &max.to_be_bytes::<32>());

		let result = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			U256::from(20u64),
			U256::from(50u64),
		);
		assert_eq!(result, Err(Error::Overflow));
	}

	#[test]
	fn write_option_rejects_amount_exceeding_u128() {
		setup();
		let too_big = U256::from(u128::MAX) + U256::from(1);
		let result = write_option(
			tsta(),
			tstb(),
			too_big,
			U256::from(500u64),
			U256::from(20u64),
			U256::from(50u64),
		);
		assert_eq!(result, Err(Error::Overflow));
	}

	#[test]
	fn write_option_rejects_strike_exceeding_u128() {
		setup();
		let too_big = U256::from(u128::MAX) + U256::from(1);
		let result = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			too_big,
			U256::from(20u64),
			U256::from(50u64),
		);
		assert_eq!(result, Err(Error::Overflow));
	}

	#[test]
	fn write_option_rejects_premium_exceeding_u128() {
		setup();
		let too_big = U256::from(u128::MAX) + U256::from(1);
		let result = write_option(
			tsta(),
			tstb(),
			U256::from(100u64),
			U256::from(500u64),
			too_big,
			U256::from(50u64),
		);
		assert_eq!(result, Err(Error::Overflow));
	}

	#[test]
	#[should_panic(expected = "contract reverted")]
	fn erc20_returning_false_reverts() {
		setup();
		let id = write_std();

		// Set call output to all zeros — ERC20 returns false.
		mock_api::set_call_output(&[0u8; 128]);

		// buy_option calls pull_token for premium, which calls erc20_call.
		// The call succeeds (no error) but returns false → should revert.
		let _ = buy_option(id);
	}
}
