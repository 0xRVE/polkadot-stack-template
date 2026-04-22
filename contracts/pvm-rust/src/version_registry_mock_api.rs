use pallet_revive_uapi::{CallFlags, ReturnErrorCode, ReturnFlags, StorageFlags};
use std::cell::RefCell;
use std::collections::HashMap;

struct State {
	caller_addr: [u8; 20],
	self_addr: [u8; 20],
	event_count: u32,
	storage: HashMap<[u8; 32], [u8; 32]>,
}

thread_local! {
	static STATE: RefCell<State> = RefCell::new(State {
		caller_addr: [0xAA; 20],
		self_addr: [0xBB; 20],
		event_count: 0,
		storage: HashMap::new(),
	});
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
	STATE.with(|s| f(&mut s.borrow_mut()))
}

pub enum MockApi {}

impl MockApi {
	pub fn call_data_size() -> u64 {
		0
	}

	pub fn call_data_copy(_output: &mut &mut [u8], _offset: u32) {}

	pub fn caller(output: &mut [u8; 20]) {
		with_state(|s| output.copy_from_slice(&s.caller_addr));
	}

	pub fn address(output: &mut [u8; 20]) {
		with_state(|s| output.copy_from_slice(&s.self_addr));
	}

	pub fn hash_keccak_256(input: &[u8], output: &mut [u8; 32]) {
		use sha3::{Digest, Keccak256};
		let result = Keccak256::digest(input);
		output.copy_from_slice(&result);
	}

	pub fn call(
		_flags: CallFlags,
		_callee: &[u8; 20],
		_ref_time_limit: u64,
		_proof_size_limit: u64,
		_deposit: &[u8; 32],
		_value: &[u8; 32],
		_input_data: &[u8],
		_output: Option<&mut &mut [u8]>,
	) -> Result<(), ReturnErrorCode> {
		Ok(())
	}

	pub fn return_value(_flags: ReturnFlags, _return_value: &[u8]) -> ! {
		panic!("contract reverted");
	}

	pub fn deposit_event(_topics: &[[u8; 32]], _data: &[u8]) {
		with_state(|s| s.event_count += 1);
	}

	pub fn get_storage(
		_flags: StorageFlags,
		key: &[u8; 32],
		output: &mut &mut [u8],
	) -> Result<(), ReturnErrorCode> {
		with_state(|s| {
			if let Some(val) = s.storage.get(key) {
				let len = output.len().min(32);
				output[..len].copy_from_slice(&val[..len]);
				Ok(())
			} else {
				output.fill(0);
				Err(ReturnErrorCode::KeyNotFound)
			}
		})
	}

	pub fn set_storage(_flags: StorageFlags, key: &[u8; 32], value: &[u8]) -> Option<u32> {
		with_state(|s| {
			let mut buf = [0u8; 32];
			let len = value.len().min(32);
			buf[..len].copy_from_slice(&value[..len]);
			s.storage.insert(*key, buf).map(|_| 32)
		})
	}
}

// -- test helpers --

pub fn set_caller(addr: [u8; 20]) {
	with_state(|s| s.caller_addr = addr);
}

pub fn reset() {
	with_state(|s| {
		s.caller_addr = [0xAA; 20];
		s.self_addr = [0xBB; 20];
		s.event_count = 0;
		s.storage.clear();
	});
}

pub fn event_count() -> u32 {
	with_state(|s| s.event_count)
}
