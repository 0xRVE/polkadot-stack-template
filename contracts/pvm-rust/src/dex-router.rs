#![cfg_attr(not(any(feature = "abi-gen", test)), no_main, no_std)]

#[cfg(any(feature = "abi-gen", test))]
extern crate alloc;

use dex_router_encoding::{bytes_array_encoded_size, encode_bytes_array, MAX_SWAP_PATH};
use ruint::aliases::U256;

#[cfg(test)]
mod mock_api;

#[pvm_contract_macros::contract("DexRouter.sol", allocator = "bump", allocator_size = 4096)]
mod dex_router {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;
    #[cfg(not(test))]
    use pallet_revive_uapi::{CallFlags, HostFn, HostFnImpl as api, ReturnFlags};
    #[cfg(test)]
    use pallet_revive_uapi::{CallFlags, ReturnFlags};
    #[cfg(test)]
    use super::mock_api::MockApi as api;

    // Precompile address for asset-conversion (ADDRESS = 0x0420).
    const PRECOMPILE_ADDR: [u8; 20] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x04, 0x20, 0, 0,
    ];

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Error {
        PrecompileCallFailed,
        SlippageExceeded,
        UnknownSelector,
        PathTooLong,
    }

    impl AsRef<[u8]> for Error {
        fn as_ref(&self) -> &[u8] {
            match *self {
                Error::PrecompileCallFailed => b"PrecompileCallFailed",
                Error::SlippageExceeded => b"SlippageExceeded",
                Error::UnknownSelector => b"UnknownSelector",
                Error::PathTooLong => b"PathTooLong",
            }
        }
    }

    #[pvm_contract_macros::constructor]
    pub fn new() -> Result<(), Error> {
        Ok(())
    }

    // === Contract methods ===

    #[pvm_contract_macros::method]
    pub fn swap_exact_in(
        path: Vec<Vec<u8>>,
        amount_in: U256,
        amount_out_min: U256,
    ) -> Result<U256, Error> {
        if path.len() > MAX_SWAP_PATH {
            return Err(Error::PathTooLong);
        }
        let caller = get_caller();
        let path_refs: Vec<&[u8]> = path.iter().map(|p: &Vec<u8>| p.as_slice()).collect();
        let calldata = build_swap_exact_in(&path_refs, amount_in, amount_out_min, &caller, false);
        let output = call_precompile(&calldata);
        let amount_out = decode_u256(&output);
        emit_swap_executed(&caller, amount_in, amount_out);
        Ok(amount_out)
    }

    #[pvm_contract_macros::method]
    pub fn swap_exact_out(
        path: Vec<Vec<u8>>,
        amount_out: U256,
        amount_in_max: U256,
    ) -> Result<U256, Error> {
        if path.len() > MAX_SWAP_PATH {
            return Err(Error::PathTooLong);
        }
        let caller = get_caller();
        let path_refs: Vec<&[u8]> = path.iter().map(|p: &Vec<u8>| p.as_slice()).collect();
        let calldata =
            build_swap_exact_out(&path_refs, amount_out, amount_in_max, &caller, false);
        let output = call_precompile(&calldata);
        let amount_in = decode_u256(&output);
        emit_swap_executed(&caller, amount_in, amount_out);
        Ok(amount_in)
    }

    #[pvm_contract_macros::method]
    pub fn get_amount_out(asset_in: Vec<u8>, asset_out: Vec<u8>, amount_in: U256) -> U256 {
        let calldata = build_quote_exact_in(&asset_in, &asset_out, amount_in, true);
        let output = call_precompile(&calldata);
        decode_u256(&output)
    }

    #[pvm_contract_macros::method]
    pub fn get_amount_in(asset_in: Vec<u8>, asset_out: Vec<u8>, amount_out: U256) -> U256 {
        let calldata = build_quote_exact_out(&asset_in, &asset_out, amount_out, true);
        let output = call_precompile(&calldata);
        decode_u256(&output)
    }

    #[pvm_contract_macros::method]
    pub fn create_pool(asset1: Vec<u8>, asset2: Vec<u8>) -> Result<(), Error> {
        let caller = get_caller();
        let calldata = build_create_pool(&asset1, &asset2);
        call_precompile(&calldata);
        emit_pool_created(&caller);
        Ok(())
    }

    #[pvm_contract_macros::method]
    pub fn add_liquidity(
        asset1: Vec<u8>,
        asset2: Vec<u8>,
        amount1_desired: U256,
        amount2_desired: U256,
        amount1_min: U256,
        amount2_min: U256,
    ) -> Result<U256, Error> {
        let caller = get_caller();
        let calldata = build_add_liquidity(
            &asset1,
            &asset2,
            amount1_desired,
            amount2_desired,
            amount1_min,
            amount2_min,
            &caller,
        );
        let output = call_precompile(&calldata);
        let liquidity = decode_u256(&output);
        emit_liquidity_added(&caller, amount1_desired, amount2_desired);
        Ok(liquidity)
    }

    #[pvm_contract_macros::method]
    pub fn remove_liquidity(
        asset1: Vec<u8>,
        asset2: Vec<u8>,
        lp_token_burn: U256,
        amount1_min: U256,
        amount2_min: U256,
    ) -> Result<(U256, U256), Error> {
        let caller = get_caller();
        let calldata = build_remove_liquidity(
            &asset1,
            &asset2,
            lp_token_burn,
            amount1_min,
            amount2_min,
            &caller,
        );
        let output = call_precompile(&calldata);
        let amount1 = decode_u256(&output);
        let amount2 = decode_u256(&output[32..]);
        emit_liquidity_removed(&caller, lp_token_burn);
        Ok((amount1, amount2))
    }

    #[pvm_contract_macros::method]
    pub fn create_pool_and_add(
        asset1: Vec<u8>,
        asset2: Vec<u8>,
        amount1_desired: U256,
        amount2_desired: U256,
        amount1_min: U256,
        amount2_min: U256,
    ) -> Result<U256, Error> {
        let caller = get_caller();

        let create_data = build_create_pool(&asset1, &asset2);
        call_precompile(&create_data);

        let add_data = build_add_liquidity(
            &asset1,
            &asset2,
            amount1_desired,
            amount2_desired,
            amount1_min,
            amount2_min,
            &caller,
        );
        let output = call_precompile(&add_data);
        let liquidity = decode_u256(&output);
        emit_pool_created(&caller);
        emit_liquidity_added(&caller, amount1_desired, amount2_desired);
        Ok(liquidity)
    }

    #[pvm_contract_macros::fallback]
    pub fn fallback() -> Result<(), Error> {
        Err(Error::UnknownSelector)
    }

    // === Internal: precompile interaction ===

    fn get_caller() -> [u8; 20] {
        let mut caller = [0u8; 20];
        api::caller(&mut caller);
        caller
    }

    fn selector(sig: &[u8]) -> [u8; 4] {
        let mut hash = [0u8; 32];
        api::hash_keccak_256(sig, &mut hash);
        [hash[0], hash[1], hash[2], hash[3]]
    }

    fn encode_u256(val: U256) -> [u8; 32] {
        val.to_be_bytes::<32>()
    }

    fn encode_address(addr: &[u8; 20]) -> [u8; 32] {
        let mut word = [0u8; 32];
        word[12..32].copy_from_slice(addr);
        word
    }

    fn encode_bool(val: bool) -> [u8; 32] {
        let mut word = [0u8; 32];
        if val {
            word[31] = 1;
        }
        word
    }

    fn decode_u256(data: &[u8]) -> U256 {
        if data.len() < 32 {
            return U256::ZERO;
        }
        U256::from_be_bytes::<32>(data[0..32].try_into().unwrap())
    }

    fn call_precompile(calldata: &[u8]) -> [u8; 128] {
        let mut output = [0u8; 128];
        let mut output_ref = &mut output[..];
        let result = api::call(
            CallFlags::empty(),
            &PRECOMPILE_ADDR,
            u64::MAX,
            u64::MAX,
            &[u8::MAX; 32],
            &[0u8; 32],
            calldata,
            Some(&mut output_ref),
        );
        if result.is_err() {
            let sig = selector(b"PrecompileCallFailed()");
            api::return_value(ReturnFlags::REVERT, &sig);
        }
        output
    }

    /// Common encoder: selector + 2 bytes params (with offsets) + N static words
    fn encode_two_bytes(
        sig: &[u8; 4],
        a1: &[u8],
        a2: &[u8],
        static_words: &[[u8; 32]],
    ) -> Vec<u8> {
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

    // === Precompile calldata builders ===

    fn build_swap_exact_in(
        path: &[&[u8]], amount_in: U256, amount_out_min: U256, send_to: &[u8; 20], keep_alive: bool,
    ) -> Vec<u8> {
        let sig = selector(b"swapExactTokensForTokens(bytes[],uint256,uint256,address,bool)");
        let path_data_size = bytes_array_encoded_size(path);
        let total = 4 + 5 * 32 + path_data_size;
        let mut buf = vec![0u8; total];
        buf[0..4].copy_from_slice(&sig);
        let mut pos = 4;

        let mut off = [0u8; 32];
        off[28..32].copy_from_slice(&160u32.to_be_bytes());
        buf[pos..pos + 32].copy_from_slice(&off);
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&encode_u256(amount_in));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&encode_u256(amount_out_min));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&encode_address(send_to));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&encode_bool(keep_alive));
        pos += 32;
        encode_bytes_array(path, &mut buf, pos);
        buf
    }

    fn build_swap_exact_out(
        path: &[&[u8]], amount_out: U256, amount_in_max: U256, send_to: &[u8; 20], keep_alive: bool,
    ) -> Vec<u8> {
        let sig = selector(b"swapTokensForExactTokens(bytes[],uint256,uint256,address,bool)");
        let path_data_size = bytes_array_encoded_size(path);
        let total = 4 + 5 * 32 + path_data_size;
        let mut buf = vec![0u8; total];
        buf[0..4].copy_from_slice(&sig);
        let mut pos = 4;

        let mut off = [0u8; 32];
        off[28..32].copy_from_slice(&160u32.to_be_bytes());
        buf[pos..pos + 32].copy_from_slice(&off);
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&encode_u256(amount_out));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&encode_u256(amount_in_max));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&encode_address(send_to));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&encode_bool(keep_alive));
        pos += 32;
        encode_bytes_array(path, &mut buf, pos);
        buf
    }

    fn build_quote_exact_in(a_in: &[u8], a_out: &[u8], amount: U256, fee: bool) -> Vec<u8> {
        let sig = selector(b"quoteExactTokensForTokens(bytes,bytes,uint256,bool)");
        encode_two_bytes(&sig, a_in, a_out, &[encode_u256(amount), encode_bool(fee)])
    }

    fn build_quote_exact_out(a_in: &[u8], a_out: &[u8], amount: U256, fee: bool) -> Vec<u8> {
        let sig = selector(b"quoteTokensForExactTokens(bytes,bytes,uint256,bool)");
        encode_two_bytes(&sig, a_in, a_out, &[encode_u256(amount), encode_bool(fee)])
    }

    fn build_create_pool(a1: &[u8], a2: &[u8]) -> Vec<u8> {
        let sig = selector(b"createPool(bytes,bytes)");
        encode_two_bytes(&sig, a1, a2, &[])
    }

    fn build_add_liquidity(
        a1: &[u8], a2: &[u8], d1: U256, d2: U256, m1: U256, m2: U256, mint_to: &[u8; 20],
    ) -> Vec<u8> {
        let sig = selector(b"addLiquidity(bytes,bytes,uint256,uint256,uint256,uint256,address)");
        encode_two_bytes(&sig, a1, a2, &[
            encode_u256(d1), encode_u256(d2), encode_u256(m1), encode_u256(m2),
            encode_address(mint_to),
        ])
    }

    fn build_remove_liquidity(
        a1: &[u8], a2: &[u8], lp: U256, m1: U256, m2: U256, to: &[u8; 20],
    ) -> Vec<u8> {
        let sig = selector(b"removeLiquidity(bytes,bytes,uint256,uint256,uint256,address)");
        encode_two_bytes(&sig, a1, a2, &[
            encode_u256(lp), encode_u256(m1), encode_u256(m2), encode_address(to),
        ])
    }

    // === Events ===

    fn emit_swap_executed(sender: &[u8; 20], amount_in: U256, amount_out: U256) {
        let mut sig = [0u8; 32];
        api::hash_keccak_256(b"SwapExecuted(address,uint256,uint256)", &mut sig);
        let mut sender_topic = [0u8; 32];
        sender_topic[12..32].copy_from_slice(sender);
        let mut data = [0u8; 64];
        data[0..32].copy_from_slice(&encode_u256(amount_in));
        data[32..64].copy_from_slice(&encode_u256(amount_out));
        api::deposit_event(&[sig, sender_topic], &data);
    }

    fn emit_pool_created(creator: &[u8; 20]) {
        let mut sig = [0u8; 32];
        api::hash_keccak_256(b"PoolCreated(address)", &mut sig);
        let mut t = [0u8; 32];
        t[12..32].copy_from_slice(creator);
        api::deposit_event(&[sig, t], &[]);
    }

    fn emit_liquidity_added(provider: &[u8; 20], a1: U256, a2: U256) {
        let mut sig = [0u8; 32];
        api::hash_keccak_256(b"LiquidityAdded(address,uint256,uint256)", &mut sig);
        let mut t = [0u8; 32];
        t[12..32].copy_from_slice(provider);
        let mut data = [0u8; 64];
        data[0..32].copy_from_slice(&encode_u256(a1));
        data[32..64].copy_from_slice(&encode_u256(a2));
        api::deposit_event(&[sig, t], &data);
    }

    fn emit_liquidity_removed(provider: &[u8; 20], lp: U256) {
        let mut sig = [0u8; 32];
        api::hash_keccak_256(b"LiquidityRemoved(address,uint256)", &mut sig);
        let mut t = [0u8; 32];
        t[12..32].copy_from_slice(provider);
        api::deposit_event(&[sig, t], &encode_u256(lp));
    }
}

#[cfg(test)]
mod tests {
    use super::dex_router::*;
    use super::mock_api;
    use alloc::vec;
    use alloc::vec::Vec;
    use ruint::aliases::U256;

    fn setup() {
        mock_api::reset();
        // Put a recognisable amount_out (1000) in the first 32 bytes of call output.
        let mut out = [0u8; 128];
        out[..32].copy_from_slice(&U256::from(1000u64).to_be_bytes::<32>());
        mock_api::set_call_output(&out);
    }

    fn make_path(n: usize) -> Vec<Vec<u8>> {
        (0..n).map(|i| vec![i as u8; 20]).collect()
    }

    // -- PathTooLong validation --

    #[test]
    fn swap_exact_in_rejects_long_path() {
        setup();
        let path = make_path(9);
        let result = swap_exact_in(path, U256::from(100u64), U256::ZERO);
        assert_eq!(result, Err(Error::PathTooLong));
    }

    #[test]
    fn swap_exact_out_rejects_long_path() {
        setup();
        let path = make_path(9);
        let result = swap_exact_out(path, U256::from(100u64), U256::MAX);
        assert_eq!(result, Err(Error::PathTooLong));
    }

    // -- Happy path --

    #[test]
    fn swap_exact_in_succeeds() {
        setup();
        let path = make_path(2);
        let result = swap_exact_in(path, U256::from(100u64), U256::ZERO);
        assert_eq!(result, Ok(U256::from(1000u64)));
    }

    #[test]
    fn swap_exact_out_succeeds() {
        setup();
        let path = make_path(2);
        let result = swap_exact_out(path, U256::from(100u64), U256::MAX);
        assert_eq!(result, Ok(U256::from(1000u64)));
    }

    #[test]
    fn swap_exact_in_at_max_path_length() {
        setup();
        let path = make_path(8);
        let result = swap_exact_in(path, U256::from(50u64), U256::ZERO);
        assert!(result.is_ok());
    }

    // -- Precompile failure --

    #[test]
    #[should_panic(expected = "contract reverted")]
    fn swap_exact_in_reverts_on_precompile_failure() {
        setup();
        mock_api::set_call_should_fail(true);
        let path = make_path(2);
        // call_precompile calls api::return_value on error, which panics in the mock
        let _ = swap_exact_in(path, U256::from(100u64), U256::ZERO);
    }

    // -- Events --

    #[test]
    fn swap_emits_event() {
        setup();
        let path = make_path(2);
        let _ = swap_exact_in(path, U256::from(100u64), U256::ZERO);
        assert_eq!(mock_api::event_count(), 1);
    }

    #[test]
    fn create_pool_and_add_emits_two_events() {
        setup();
        let a1 = vec![1u8; 20];
        let a2 = vec![2u8; 20];
        let _ = create_pool_and_add(
            a1, a2,
            U256::from(1000u64), U256::from(1000u64),
            U256::ZERO, U256::ZERO,
        );
        // pool_created + liquidity_added
        assert_eq!(mock_api::event_count(), 2);
    }
}
