use pallet_revive_uapi::{CallFlags, ReturnErrorCode, ReturnFlags};
use std::sync::Mutex;

struct State {
	caller_addr: [u8; 20],
	self_addr: [u8; 20],
	call_should_fail: bool,
	call_output: [u8; 128],
	event_count: u32,
	call_count: u32,
}

static STATE: Mutex<State> = Mutex::new(State {
	caller_addr: [0xAA; 20],
	self_addr: [0xBB; 20],
	call_should_fail: false,
	call_output: [0u8; 128],
	event_count: 0,
	call_count: 0,
});

pub enum MockApi {}

impl MockApi {
	// -- Dispatch helpers (used by macro-generated code) --

	pub fn call_data_size() -> u64 {
		0
	}

	pub fn call_data_copy(_output: &mut &mut [u8], _offset: u32) {}

	// -- Contract API --

	pub fn caller(output: &mut [u8; 20]) {
		output.copy_from_slice(&STATE.lock().unwrap().caller_addr);
	}

	pub fn address(output: &mut [u8; 20]) {
		output.copy_from_slice(&STATE.lock().unwrap().self_addr);
	}

	pub fn hash_keccak_256(input: &[u8], output: &mut [u8; 32]) {
		// FNV-1a — deterministic, sufficient for selector generation in tests.
		let mut h: u64 = 0xcbf29ce484222325;
		for &b in input {
			h ^= b as u64;
			h = h.wrapping_mul(0x100000001b3);
		}
		output.fill(0);
		output[..8].copy_from_slice(&h.to_be_bytes());
	}

	pub fn call(
		_flags: CallFlags,
		_callee: &[u8; 20],
		_ref_time_limit: u64,
		_proof_size_limit: u64,
		_deposit: &[u8; 32],
		_value: &[u8; 32],
		_input_data: &[u8],
		output: Option<&mut &mut [u8]>,
	) -> Result<(), ReturnErrorCode> {
		let mut state = STATE.lock().unwrap();
		state.call_count += 1;
		if state.call_should_fail {
			return Err(ReturnErrorCode::CalleeTrapped);
		}
		if let Some(out) = output {
			let len = out.len().min(state.call_output.len());
			out[..len].copy_from_slice(&state.call_output[..len]);
		}
		Ok(())
	}

	pub fn return_value(_flags: ReturnFlags, _return_value: &[u8]) -> ! {
		panic!("contract reverted");
	}

	pub fn deposit_event(_topics: &[[u8; 32]], _data: &[u8]) {
		STATE.lock().unwrap().event_count += 1;
	}
}

// -- test helpers --

pub fn set_call_output(data: &[u8]) {
	let mut state = STATE.lock().unwrap();
	let len = data.len().min(128);
	state.call_output[..len].copy_from_slice(&data[..len]);
}

pub fn set_call_should_fail(fail: bool) {
	STATE.lock().unwrap().call_should_fail = fail;
}

pub fn reset() {
	let mut state = STATE.lock().unwrap();
	state.caller_addr = [0xAA; 20];
	state.self_addr = [0xBB; 20];
	state.call_should_fail = false;
	state.call_output = [0u8; 128];
	state.event_count = 0;
	state.call_count = 0;
}

pub fn event_count() -> u32 {
	STATE.lock().unwrap().event_count
}

pub fn call_count() -> u32 {
	STATE.lock().unwrap().call_count
}
