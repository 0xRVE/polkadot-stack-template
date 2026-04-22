#![cfg_attr(not(any(feature = "abi-gen", test)), no_main, no_std)]

#[cfg(any(feature = "abi-gen", test))]
extern crate alloc;

use ruint::aliases::U256;

#[cfg(test)]
#[path = "version_registry_mock_api.rs"]
mod mock_api;

/// VersionRegistry — multi-contract version registry.
/// Tracks deployed implementation addresses by name and version number.
/// Each contract family (e.g. "covered-call", "futures") has its own
/// independent version chain. Only the owner (deployer) can register.
#[cfg_attr(
	not(test),
	pvm_contract_macros::contract(
		"VersionRegistry.sol",
		allocator = "bump",
		allocator_size = 4096
	)
)]
mod version_registry {
	#[cfg(test)]
	use super::mock_api::MockApi as api;
	use super::*;
	#[cfg(not(test))]
	use pallet_revive_uapi::{HostFn, HostFnImpl as api, ReturnFlags, StorageFlags};
	#[cfg(test)]
	use pallet_revive_uapi::{ReturnFlags, StorageFlags};

	// ── Constants ────────────────────────────────────────────────────────

	/// Storage slot for the contract owner.
	const SLOT_OWNER: [u8; 32] = [0u8; 32];

	/// Tag for per-name version count: keccak(name || TAG_COUNT)
	const TAG_COUNT: u8 = 0x00;

	/// Tag for per-name-version address: keccak(name || version || TAG_ADDRESS)
	const TAG_ADDRESS: u8 = 0x01;

	// ── Errors ───────────────────────────────────────────────────────────

	#[derive(Debug, Clone, Copy, PartialEq, Eq)]
	pub enum Error {
		NotOwner,
		InvalidAddress,
		VersionNotFound,
		StorageError,
		UnknownSelector,
	}

	impl AsRef<[u8]> for Error {
		fn as_ref(&self) -> &[u8] {
			match *self {
				Error::NotOwner => b"NotOwner",
				Error::InvalidAddress => b"InvalidAddress",
				Error::VersionNotFound => b"VersionNotFound",
				Error::StorageError => b"StorageError",
				Error::UnknownSelector => b"UnknownSelector",
			}
		}
	}

	// ── Constructor ──────────────────────────────────────────────────────

	#[pvm_contract_macros::constructor]
	pub fn new() -> Result<(), Error> {
		let caller = caller_addr();
		storage_set_addr(&SLOT_OWNER, &caller);
		Ok(())
	}

	// ── Methods ──────────────────────────────────────────────────────────

	#[pvm_contract_macros::method]
	pub fn register_version(
		name: U256,
		implementation: pvm_contract_types::Address,
	) -> Result<U256, Error> {
		let caller = caller_addr();
		let owner_addr = storage_get_addr(&SLOT_OWNER);
		if caller != owner_addr {
			return Err(Error::NotOwner);
		}
		if implementation.0 == [0u8; 20] {
			return Err(Error::InvalidAddress);
		}

		// Increment per-name version counter (1-indexed).
		let count_key = name_slot(name, TAG_COUNT);
		let count = storage_get_u256(&count_key);
		let version = count + U256::from(1);
		storage_set_u256(&count_key, version);

		// Store implementation address.
		let addr_key = name_version_slot(name, version, TAG_ADDRESS);
		storage_set_addr(&addr_key, &implementation.0);

		emit_version_registered(name, version, &implementation.0);
		Ok(version)
	}

	// TODO: switch to two-step ownership transfer (transfer + accept) to prevent
	// irrecoverable loss if transferred to the wrong address.
	#[pvm_contract_macros::method]
	pub fn transfer_ownership(new_owner: pvm_contract_types::Address) -> Result<(), Error> {
		let caller = caller_addr();
		let owner_addr = storage_get_addr(&SLOT_OWNER);
		if caller != owner_addr {
			return Err(Error::NotOwner);
		}
		if new_owner.0 == [0u8; 20] {
			return Err(Error::InvalidAddress);
		}

		storage_set_addr(&SLOT_OWNER, &new_owner.0);
		emit_ownership_transferred(&caller, &new_owner.0);
		Ok(())
	}

	// TODO: add deprecateVersion(bytes32 name, uint256 version) to zero out a
	// buggy implementation address. Currently registered versions are permanent.

	#[pvm_contract_macros::method]
	pub fn latest(name: U256) -> pvm_contract_types::Address {
		let count = storage_get_u256(&name_slot(name, TAG_COUNT));
		if count == U256::ZERO {
			return pvm_contract_types::Address([0u8; 20]);
		}
		let addr = storage_get_addr(&name_version_slot(name, count, TAG_ADDRESS));
		pvm_contract_types::Address(addr)
	}

	#[pvm_contract_macros::method]
	pub fn get_version(name: U256, version: U256) -> Result<pvm_contract_types::Address, Error> {
		let count = storage_get_u256(&name_slot(name, TAG_COUNT));
		if version == U256::ZERO || version > count {
			return Err(Error::VersionNotFound);
		}
		let addr = storage_get_addr(&name_version_slot(name, version, TAG_ADDRESS));
		Ok(pvm_contract_types::Address(addr))
	}

	#[pvm_contract_macros::method]
	pub fn version_count(name: U256) -> U256 {
		storage_get_u256(&name_slot(name, TAG_COUNT))
	}

	#[pvm_contract_macros::method]
	pub fn owner() -> pvm_contract_types::Address {
		pvm_contract_types::Address(storage_get_addr(&SLOT_OWNER))
	}

	#[pvm_contract_macros::fallback]
	pub fn fallback() -> Result<(), Error> {
		Err(Error::UnknownSelector)
	}

	// ── Helpers ──────────────────────────────────────────────────────────

	fn revert(err: Error) -> ! {
		api::return_value(ReturnFlags::REVERT, err.as_ref());
	}

	fn caller_addr() -> [u8; 20] {
		let mut buf = [0u8; 20];
		api::caller(&mut buf);
		buf
	}

	/// Storage key for per-name data: keccak(name_bytes || tag)
	fn name_slot(name: U256, tag: u8) -> [u8; 32] {
		let mut preimage = [0u8; 33];
		preimage[..32].copy_from_slice(&name.to_be_bytes::<32>());
		preimage[32] = tag;
		let mut hash = [0u8; 32];
		api::hash_keccak_256(&preimage, &mut hash);
		hash
	}

	/// Storage key for per-name-version data: keccak(name_bytes || version_bytes || tag)
	fn name_version_slot(name: U256, version: U256, tag: u8) -> [u8; 32] {
		let mut preimage = [0u8; 65];
		preimage[..32].copy_from_slice(&name.to_be_bytes::<32>());
		preimage[32..64].copy_from_slice(&version.to_be_bytes::<32>());
		preimage[64] = tag;
		let mut hash = [0u8; 32];
		api::hash_keccak_256(&preimage, &mut hash);
		hash
	}

	fn storage_get_u256(key: &[u8; 32]) -> U256 {
		let mut buf = [0u8; 32];
		let mut out = &mut buf[..];
		match api::get_storage(StorageFlags::empty(), key, &mut out) {
			Ok(()) | Err(pallet_revive_uapi::ReturnErrorCode::KeyNotFound) => {}
			Err(_) => revert(Error::StorageError),
		}
		U256::from_be_bytes::<32>(buf)
	}

	fn storage_set_u256(key: &[u8; 32], val: U256) {
		api::set_storage(StorageFlags::empty(), key, &val.to_be_bytes::<32>());
	}

	fn storage_get_addr(key: &[u8; 32]) -> [u8; 20] {
		let mut buf = [0u8; 32];
		let mut out = &mut buf[..];
		match api::get_storage(StorageFlags::empty(), key, &mut out) {
			Ok(()) | Err(pallet_revive_uapi::ReturnErrorCode::KeyNotFound) => {}
			Err(_) => revert(Error::UnknownSelector),
		}
		let mut addr = [0u8; 20];
		addr.copy_from_slice(&buf[12..32]);
		addr
	}

	fn storage_set_addr(key: &[u8; 32], addr: &[u8; 20]) {
		let mut buf = [0u8; 32];
		buf[12..32].copy_from_slice(addr);
		api::set_storage(StorageFlags::empty(), key, &buf);
	}

	fn emit_version_registered(name: U256, version: U256, implementation: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"VersionRegistered(bytes32,uint256,address)", &mut sig);
		let mut t_impl = [0u8; 32];
		t_impl[12..32].copy_from_slice(implementation);
		api::deposit_event(&[sig, name.to_be_bytes::<32>(), version.to_be_bytes::<32>(), t_impl], &[]);
	}

	fn emit_ownership_transferred(prev: &[u8; 20], new: &[u8; 20]) {
		let mut sig = [0u8; 32];
		api::hash_keccak_256(b"OwnershipTransferred(address,address)", &mut sig);
		let mut t_prev = [0u8; 32];
		t_prev[12..32].copy_from_slice(prev);
		let mut t_new = [0u8; 32];
		t_new[12..32].copy_from_slice(new);
		api::deposit_event(&[sig, t_prev, t_new], &[]);
	}
}

// ── Unit tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::{mock_api, version_registry::*};
	use ruint::aliases::U256;

	// Contract family names as U256 (bytes32 equivalent)
	fn name_covered_call() -> U256 {
		// bytes32("covered-call") — just use a distinct constant
		U256::from(1)
	}

	fn name_futures() -> U256 {
		U256::from(2)
	}

	fn addr(fill: u8) -> pvm_contract_types::Address {
		pvm_contract_types::Address([fill; 20])
	}

	fn zero_addr() -> pvm_contract_types::Address {
		pvm_contract_types::Address([0u8; 20])
	}

	#[test]
	fn constructor_sets_owner() {
		mock_api::reset();
		new().unwrap();
		let o = owner();
		assert_eq!(o.0, [0xAA; 20]);
	}

	#[test]
	fn register_and_retrieve_single_name() {
		mock_api::reset();
		new().unwrap();
		let n = name_covered_call();

		let v1 = register_version(n, addr(0x11)).unwrap();
		assert_eq!(v1, U256::from(1));
		assert_eq!(version_count(n), U256::from(1));
		assert_eq!(get_version(n, U256::from(1)).unwrap().0, [0x11; 20]);
		assert_eq!(latest(n).0, [0x11; 20]);

		let v2 = register_version(n, addr(0x22)).unwrap();
		assert_eq!(v2, U256::from(2));
		assert_eq!(latest(n).0, [0x22; 20]);
		// v1 still accessible
		assert_eq!(get_version(n, U256::from(1)).unwrap().0, [0x11; 20]);
	}

	#[test]
	fn independent_version_chains() {
		mock_api::reset();
		new().unwrap();
		let cc = name_covered_call();
		let ft = name_futures();

		register_version(cc, addr(0x11)).unwrap();
		register_version(cc, addr(0x22)).unwrap();
		register_version(ft, addr(0xAA)).unwrap();

		// covered-call has 2 versions
		assert_eq!(version_count(cc), U256::from(2));
		assert_eq!(latest(cc).0, [0x22; 20]);

		// futures has 1 version
		assert_eq!(version_count(ft), U256::from(1));
		assert_eq!(latest(ft).0, [0xAA; 20]);

		// They don't interfere
		assert_eq!(get_version(cc, U256::from(1)).unwrap().0, [0x11; 20]);
		assert_eq!(get_version(ft, U256::from(1)).unwrap().0, [0xAA; 20]);
	}

	#[test]
	fn latest_returns_zero_for_unknown_name() {
		mock_api::reset();
		new().unwrap();
		assert_eq!(latest(U256::from(999)), zero_addr());
	}

	#[test]
	fn get_version_rejects_out_of_range() {
		mock_api::reset();
		new().unwrap();
		let n = name_covered_call();

		assert_eq!(get_version(n, U256::from(0)), Err(Error::VersionNotFound));
		assert_eq!(get_version(n, U256::from(1)), Err(Error::VersionNotFound));

		register_version(n, addr(0x11)).unwrap();
		assert_eq!(get_version(n, U256::from(2)), Err(Error::VersionNotFound));
	}

	#[test]
	fn register_rejects_zero_address() {
		mock_api::reset();
		new().unwrap();
		assert_eq!(register_version(name_covered_call(), zero_addr()), Err(Error::InvalidAddress));
	}

	#[test]
	fn register_rejects_non_owner() {
		mock_api::reset();
		new().unwrap();
		mock_api::set_caller([0xCC; 20]);
		assert_eq!(register_version(name_covered_call(), addr(0x11)), Err(Error::NotOwner));
	}

	#[test]
	fn transfer_ownership_works() {
		mock_api::reset();
		new().unwrap();

		let new_owner = [0xDD; 20];
		transfer_ownership(pvm_contract_types::Address(new_owner)).unwrap();
		assert_eq!(owner().0, new_owner);

		// Old owner blocked
		assert_eq!(register_version(name_covered_call(), addr(0x11)), Err(Error::NotOwner));

		// New owner can register
		mock_api::set_caller(new_owner);
		assert!(register_version(name_covered_call(), addr(0x11)).is_ok());
	}

	#[test]
	fn transfer_ownership_rejects_non_owner() {
		mock_api::reset();
		new().unwrap();
		mock_api::set_caller([0xCC; 20]);
		assert_eq!(
			transfer_ownership(pvm_contract_types::Address([0xDD; 20])),
			Err(Error::NotOwner)
		);
	}

	#[test]
	fn transfer_ownership_rejects_zero_address() {
		mock_api::reset();
		new().unwrap();
		assert_eq!(transfer_ownership(zero_addr()), Err(Error::InvalidAddress));
	}

	#[test]
	fn emits_events() {
		mock_api::reset();
		new().unwrap();

		assert_eq!(mock_api::event_count(), 0);
		register_version(name_covered_call(), addr(0x11)).unwrap();
		assert_eq!(mock_api::event_count(), 1);
		register_version(name_futures(), addr(0x22)).unwrap();
		assert_eq!(mock_api::event_count(), 2);
		transfer_ownership(pvm_contract_types::Address([0xDD; 20])).unwrap();
		assert_eq!(mock_api::event_count(), 3);
	}
}
