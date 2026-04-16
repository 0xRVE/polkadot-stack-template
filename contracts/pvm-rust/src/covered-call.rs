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
	const PRECOMPILE: [u8; 20] =
		[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x04, 0x20, 0, 0];

	/// ERC20 precompile prefix bytes at [16..18] (InlineIdConfig<0x0120>).
	const ERC20_BYTE16: u8 = 0x01;
	const ERC20_BYTE17: u8 = 0x20;

	// Storage tags for per-option slots.
	const TAG_SELLER: u8 = 0x00;
	const TAG_UNDERLYING: u8 = 0x01;
	const TAG_STRIKE_ASSET: u8 = 0x02;
	const TAG_AMOUNT: u8 = 0x03;
	const TAG_STRIKE_PRICE: u8 = 0x04;
	const TAG_EXPIRY: u8 = 0x05;
	const TAG_STATUS: u8 = 0x06;

	const STATUS_ACTIVE: u8 = 0;
	const STATUS_EXERCISED: u8 = 1;
	const STATUS_EXPIRED: u8 = 2;

	/// Global slot for next option ID counter.
	const SLOT_NEXT_ID: [u8; 32] = [0u8; 32];

	// ── Errors ───────────────────────────────────────────────────────────

	#[derive(Debug, Clone, Copy, PartialEq, Eq)]
	pub enum Error {
		PrecompileCallFailed,
		TransferFromFailed,
		OptionNotActive,
		OptionNotExpired,
		OptionAlreadyExpired,
		NotInTheMoney,
		InvalidAsset,
		InvalidAmount,
		InvalidExpiry,
		UnknownSelector,
	}

	impl AsRef<[u8]> for Error {
		fn as_ref(&self) -> &[u8] {
			match *self {
				Error::PrecompileCallFailed => b"PrecompileCallFailed",
				Error::TransferFromFailed => b"TransferFromFailed",
				Error::OptionNotActive => b"OptionNotActive",
				Error::OptionNotExpired => b"OptionNotExpired",
				Error::OptionAlreadyExpired => b"OptionAlreadyExpired",
				Error::NotInTheMoney => b"NotInTheMoney",
				Error::InvalidAsset => b"InvalidAsset",
				Error::InvalidAmount => b"InvalidAmount",
				Error::InvalidExpiry => b"InvalidExpiry",
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
		strike_price: U256,
		expiry: U256,
	) -> Result<U256, Error> {
		if amount == U256::ZERO || strike_price == U256::ZERO {
			return Err(Error::InvalidAmount);
		}
		let current_block = block_number();
		if expiry <= current_block {
			return Err(Error::InvalidExpiry);
		}
		if erc20_of(&underlying.0).is_none() {
			return Err(Error::InvalidAsset);
		}
		if erc20_of(&strike_asset.0).is_none() {
			return Err(Error::InvalidAsset);
		}

		let caller = caller_addr();
		let me = self_addr();

		// Read and increment counter.
		let option_id = storage_get_u256(&SLOT_NEXT_ID);
		storage_set_u256(&SLOT_NEXT_ID, option_id + U256::from(1));

		// Pull collateral from caller.
		pull_token(&underlying.0, &caller, &me, amount);

		// Store option fields.
		storage_set_addr(&option_slot(option_id, TAG_SELLER), &caller);
		storage_set_bytes(&option_slot(option_id, TAG_UNDERLYING), &underlying.0);
		storage_set_bytes(&option_slot(option_id, TAG_STRIKE_ASSET), &strike_asset.0);
		storage_set_u256(&option_slot(option_id, TAG_AMOUNT), amount);
		storage_set_u256(&option_slot(option_id, TAG_STRIKE_PRICE), strike_price);
		storage_set_u256(&option_slot(option_id, TAG_EXPIRY), expiry);
		storage_set_u256(&option_slot(option_id, TAG_STATUS), U256::from(STATUS_ACTIVE));

		emit_option_written(option_id, &caller, amount, strike_price, expiry);
		Ok(option_id)
	}

	#[pvm_contract_macros::method]
	pub fn exercise_option(option_id: U256) -> Result<(), Error> {
		// Check active.
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));
		if status != U256::from(STATUS_ACTIVE) {
			return Err(Error::OptionNotActive);
		}

		// Check not expired.
		let expiry = storage_get_u256(&option_slot(option_id, TAG_EXPIRY));
		let current_block = block_number();
		if current_block >= expiry {
			return Err(Error::OptionAlreadyExpired);
		}

		// Load option details.
		let seller = storage_get_addr(&option_slot(option_id, TAG_SELLER));
		let underlying_raw = storage_get_raw(&option_slot(option_id, TAG_UNDERLYING));
		let strike_raw = storage_get_raw(&option_slot(option_id, TAG_STRIKE_ASSET));
		let amount = storage_get_u256(&option_slot(option_id, TAG_AMOUNT));
		let strike_price = storage_get_u256(&option_slot(option_id, TAG_STRIKE_PRICE));

		let u_len = asset_byte_len(&underlying_raw);
		let s_len = asset_byte_len(&strike_raw);

		// In-the-money check: market value of underlying > strike cost.
		let market_value = get_dex_quote(&underlying_raw[..u_len], &strike_raw[..s_len], amount);
		let total_cost = strike_price * amount;
		if market_value <= total_cost {
			return Err(Error::NotInTheMoney);
		}

		let caller = caller_addr();

		// Buyer pays strike asset directly to seller.
		pull_token(&strike_raw[..s_len], &caller, &seller, total_cost);

		// Release collateral to buyer.
		push_token(&underlying_raw[..u_len], &caller, amount);

		// Mark exercised.
		storage_set_u256(
			&option_slot(option_id, TAG_STATUS),
			U256::from(STATUS_EXERCISED),
		);

		emit_option_exercised(option_id, &caller);
		Ok(())
	}

	#[pvm_contract_macros::method]
	pub fn expire_option(option_id: U256) -> Result<(), Error> {
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));
		if status != U256::from(STATUS_ACTIVE) {
			return Err(Error::OptionNotActive);
		}

		let expiry = storage_get_u256(&option_slot(option_id, TAG_EXPIRY));
		let current_block = block_number();
		if current_block < expiry {
			return Err(Error::OptionNotExpired);
		}

		let seller = storage_get_addr(&option_slot(option_id, TAG_SELLER));
		let underlying_raw = storage_get_raw(&option_slot(option_id, TAG_UNDERLYING));
		let amount = storage_get_u256(&option_slot(option_id, TAG_AMOUNT));
		let u_len = asset_byte_len(&underlying_raw);

		// Return collateral to seller.
		push_token(&underlying_raw[..u_len], &seller, amount);

		storage_set_u256(
			&option_slot(option_id, TAG_STATUS),
			U256::from(STATUS_EXPIRED),
		);

		emit_option_expired(option_id, &seller);
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
	) {
		let seller = storage_get_addr(&option_slot(option_id, TAG_SELLER));
		let underlying_raw = storage_get_raw(&option_slot(option_id, TAG_UNDERLYING));
		let strike_raw = storage_get_raw(&option_slot(option_id, TAG_STRIKE_ASSET));
		let amount = storage_get_u256(&option_slot(option_id, TAG_AMOUNT));
		let strike_price = storage_get_u256(&option_slot(option_id, TAG_STRIKE_PRICE));
		let expiry = storage_get_u256(&option_slot(option_id, TAG_EXPIRY));
		let status = storage_get_u256(&option_slot(option_id, TAG_STATUS));

		let u_len = asset_byte_len(&underlying_raw);
		let s_len = asset_byte_len(&strike_raw);

		(
			pvm_contract_types::Address(seller),
			Bytes(underlying_raw[..u_len].to_vec()),
			Bytes(strike_raw[..s_len].to_vec()),
			amount,
			strike_price,
			expiry,
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

	/// Determine the byte length of a SCALE-encoded NativeOrWithId.
	fn asset_byte_len(raw: &[u8; 32]) -> usize {
		match raw[0] {
			0x00 => 1,
			0x01 => 5,
			_ => 0,
		}
	}

	fn block_number() -> U256 {
		let mut buf = [0u8; 32];
		api::block_number(&mut buf);
		U256::from_be_bytes::<32>(buf)
	}

	// ── DEX quote ────────────────────────────────────────────────────────

	fn get_dex_quote(underlying: &[u8], strike_asset: &[u8], amount: U256) -> U256 {
		let calldata = build_quote_exact_in(underlying, strike_asset, amount, true);
		let out = dex_call(&calldata);
		dec_u256(&out)
	}

	fn build_quote_exact_in(a_in: &[u8], a_out: &[u8], amount: U256, fee: bool) -> Vec<u8> {
		let s = sel(b"quoteExactTokensForTokens(bytes,bytes,uint256,bool)");
		enc_two_bytes(&s, a_in, a_out, &[enc_u256(amount), enc_bool(fee)])
	}

	// ── Token management ─────────────────────────────────────────────────

	fn pull_token(asset: &[u8], from: &[u8; 20], to: &[u8; 20], amount: U256) {
		if let Some(erc20) = erc20_of(asset) {
			erc20_call(&erc20, &build_transfer_from(from, to, amount));
		}
	}

	fn push_token(asset: &[u8], to: &[u8; 20], amount: U256) {
		if let Some(erc20) = erc20_of(asset) {
			erc20_call(&erc20, &build_erc20_transfer(to, amount));
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
		do_call(addr, calldata, b"TransferFromFailed()")
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
		seller: &[u8; 20],
		amount: U256,
		strike_price: U256,
		expiry: U256,
	) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(
			b"OptionWritten(uint256,address,uint256,uint256,uint256)",
			&mut sig,
		);
		let t_id = enc_u256(id);
		let mut t_seller = [0u8; 32];
		t_seller[12..32].copy_from_slice(seller);
		let mut data = [0u8; 96];
		data[0..32].copy_from_slice(&enc_u256(amount));
		data[32..64].copy_from_slice(&enc_u256(strike_price));
		data[64..96].copy_from_slice(&enc_u256(expiry));
		api::deposit_event(&[sig, t_id, t_seller], &data);
	}

	fn emit_option_exercised(id: U256, buyer: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OptionExercised(uint256,address)", &mut sig);
		let t_id = enc_u256(id);
		let mut t_buyer = [0u8; 32];
		t_buyer[12..32].copy_from_slice(buyer);
		api::deposit_event(&[sig, t_id, t_buyer], &[]);
	}

	fn emit_option_expired(id: U256, seller: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OptionExpired(uint256,address)", &mut sig);
		let t_id = enc_u256(id);
		let mut t_seller = [0u8; 32];
		t_seller[12..32].copy_from_slice(seller);
		api::deposit_event(&[sig, t_id, t_seller], &[]);
	}
}

// ── Unit tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::covered_call::*;
	use super::mock_api;
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
		// Set block number to 10.
		mock_api::set_block_number(10);
	}

	#[test]
	fn write_option_stores_and_returns_id() {
		setup();
		let result = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(50u64));
		assert_eq!(result, Ok(U256::ZERO)); // First option = id 0.
		assert_eq!(next_option_id(), U256::from(1u64));
		// 1 ERC20 transferFrom to pull collateral.
		assert_eq!(mock_api::call_count(), 1);
		assert_eq!(mock_api::event_count(), 1);
	}

	#[test]
	fn write_option_increments_counter() {
		setup();
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(50u64));
		let result = write_option(tstb(), tsta(), U256::from(200u64), U256::from(10u64), U256::from(60u64));
		assert_eq!(result, Ok(U256::from(1u64))); // Second option = id 1.
		assert_eq!(next_option_id(), U256::from(2u64));
	}

	#[test]
	fn write_option_rejects_zero_amount() {
		setup();
		let result = write_option(tsta(), tstb(), U256::ZERO, U256::from(5u64), U256::from(50u64));
		assert_eq!(result, Err(Error::InvalidAmount));
	}

	#[test]
	fn write_option_rejects_zero_strike() {
		setup();
		let result = write_option(tsta(), tstb(), U256::from(100u64), U256::ZERO, U256::from(50u64));
		assert_eq!(result, Err(Error::InvalidAmount));
	}

	#[test]
	fn write_option_rejects_past_expiry() {
		setup();
		// Block is 10, expiry is 5.
		let result = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(5u64));
		assert_eq!(result, Err(Error::InvalidExpiry));
	}

	#[test]
	fn write_option_rejects_native_asset() {
		setup();
		let native = b(vec![0x00]);
		let result = write_option(native, tstb(), U256::from(100u64), U256::from(5u64), U256::from(50u64));
		assert_eq!(result, Err(Error::InvalidAsset));
	}

	#[test]
	fn expire_option_returns_collateral() {
		setup();
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(15u64));

		// Advance block past expiry.
		mock_api::set_block_number(20);
		mock_api::reset_counts();

		let result = expire_option(U256::ZERO);
		assert_eq!(result, Ok(()));
		// 1 ERC20 transfer to return collateral.
		assert_eq!(mock_api::call_count(), 1);
		assert_eq!(mock_api::event_count(), 1);
	}

	#[test]
	fn expire_option_rejects_before_expiry() {
		setup();
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(50u64));
		// Block is still 10, expiry is 50.
		let result = expire_option(U256::ZERO);
		assert_eq!(result, Err(Error::OptionNotExpired));
	}

	#[test]
	fn expire_option_rejects_already_expired() {
		setup();
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(15u64));
		mock_api::set_block_number(20);
		let _ = expire_option(U256::ZERO);

		// Try again — status is now expired.
		let result = expire_option(U256::ZERO);
		assert_eq!(result, Err(Error::OptionNotActive));
	}

	#[test]
	fn exercise_option_when_in_the_money() {
		setup();
		// Write option: amount=100, strike_price=5, expiry=50.
		// total_cost = 5 * 100 = 500.
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(50u64));

		// Mock DEX quote returns 1000 > total_cost 500 → in the money.
		mock_api::set_call_output(&U256::from(1000u64).to_be_bytes::<32>());
		mock_api::reset_counts();

		let result = exercise_option(U256::ZERO);
		assert_eq!(result, Ok(()));
		// 1 DEX quote + 1 transferFrom (buyer pays seller) + 1 transfer (collateral to buyer) = 3.
		assert_eq!(mock_api::call_count(), 3);
		assert_eq!(mock_api::event_count(), 1);
	}

	#[test]
	fn exercise_option_rejects_out_of_the_money() {
		setup();
		// Write option: amount=100, strike_price=5. total_cost = 500.
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(50u64));

		// Mock DEX quote returns 400 < total_cost 500 → out of the money.
		mock_api::set_call_output(&U256::from(400u64).to_be_bytes::<32>());
		mock_api::reset_counts();

		let result = exercise_option(U256::ZERO);
		assert_eq!(result, Err(Error::NotInTheMoney));
	}

	#[test]
	fn exercise_option_rejects_after_expiry() {
		setup();
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(15u64));
		mock_api::set_block_number(20);

		let result = exercise_option(U256::ZERO);
		assert_eq!(result, Err(Error::OptionAlreadyExpired));
	}

	#[test]
	fn exercise_option_rejects_already_exercised() {
		setup();
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(50u64));
		mock_api::set_call_output(&U256::from(1000u64).to_be_bytes::<32>());
		let _ = exercise_option(U256::ZERO);

		let result = exercise_option(U256::ZERO);
		assert_eq!(result, Err(Error::OptionNotActive));
	}

	#[test]
	fn get_option_returns_stored_values() {
		setup();
		let _ = write_option(tsta(), tstb(), U256::from(100u64), U256::from(5u64), U256::from(50u64));

		let (seller, underlying, strike_asset, amount, strike_price, expiry, status) =
			get_option(U256::ZERO);
		assert_eq!(seller.0, [0xAA; 20]); // Mock caller address.
		assert_eq!(underlying.0, vec![0x01, 1, 0, 0, 0]);
		assert_eq!(strike_asset.0, vec![0x01, 2, 0, 0, 0]);
		assert_eq!(amount, U256::from(100u64));
		assert_eq!(strike_price, U256::from(5u64));
		assert_eq!(expiry, U256::from(50u64));
		assert_eq!(status, U256::ZERO); // Active.
	}
}
