#![cfg_attr(not(any(feature = "abi-gen", test)), no_main, no_std)]

#[cfg(any(feature = "abi-gen", test))]
extern crate alloc;

use dex_router_encoding::{bytes_array_encoded_size, encode_bytes_array, MAX_SWAP_PATH};
use ruint::aliases::U256;

#[cfg(test)]
mod mock_api;

/// DexRouter — pulls tokens from the caller via ERC20 approval, then
/// delegates to the asset-conversion precompile for swaps and liquidity.
#[cfg_attr(not(test), pvm_contract_macros::contract("DexRouter.sol", allocator = "bump", allocator_size = 8192))]
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

    // ── Constants ────────────────────────────────────────────────────────

    /// Asset-conversion precompile (ADDRESS = 0x0420).
    const PRECOMPILE: [u8; 20] = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x04, 0x20, 0, 0,
    ];

    /// ERC20 precompile prefix bytes at [16..18] (InlineIdConfig<0x0120>).
    /// Full address layout: [id_be32(4)][zeros(12)][0x01,0x20(2)][zeros(2)].
    const ERC20_BYTE16: u8 = 0x01;
    const ERC20_BYTE17: u8 = 0x20;

    // ── Errors ───────────────────────────────────────────────────────────

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Error {
        PrecompileCallFailed,
        TransferFromFailed,
        UnknownSelector,
        PathTooLong,
    }

    impl AsRef<[u8]> for Error {
        fn as_ref(&self) -> &[u8] {
            match *self {
                Error::PrecompileCallFailed => b"PrecompileCallFailed",
                Error::TransferFromFailed => b"TransferFromFailed",
                Error::UnknownSelector => b"UnknownSelector",
                Error::PathTooLong => b"PathTooLong",
            }
        }
    }

    // ── Constructor ──────────────────────────────────────────────────────

    #[cfg_attr(not(test), pvm_contract_macros::constructor)]
    pub fn new() -> Result<(), Error> {
        Ok(())
    }

    // ── Swap ─────────────────────────────────────────────────────────────

    #[cfg_attr(not(test), pvm_contract_macros::method)]
    pub fn swap_exact_in(
        path: Vec<Vec<u8>>,
        amount_in: U256,
        amount_out_min: U256,
    ) -> Result<U256, Error> {
        if path.len() > MAX_SWAP_PATH {
            return Err(Error::PathTooLong);
        }
        let caller = caller_addr();
        let me = self_addr();

        // Pull input token from caller → contract.
        pull_token(&path[0], &caller, &me, amount_in);

        // Execute swap; output goes directly to caller.
        let path_refs: Vec<&[u8]> = path.iter().map(|p| p.as_slice()).collect();
        let out = dex_call(&build_swap_exact_in(
            &path_refs, amount_in, amount_out_min, &caller, false,
        ));
        let amount_out = dec_u256(&out);

        emit_swap(&caller, amount_in, amount_out);
        Ok(amount_out)
    }

    #[cfg_attr(not(test), pvm_contract_macros::method)]
    pub fn swap_exact_out(
        path: Vec<Vec<u8>>,
        amount_out: U256,
        amount_in_max: U256,
    ) -> Result<U256, Error> {
        if path.len() > MAX_SWAP_PATH {
            return Err(Error::PathTooLong);
        }
        let caller = caller_addr();
        let me = self_addr();

        // Pull max input from caller.
        pull_token(&path[0], &caller, &me, amount_in_max);

        // Execute swap.
        let path_refs: Vec<&[u8]> = path.iter().map(|p| p.as_slice()).collect();
        let out = dex_call(&build_swap_exact_out(
            &path_refs, amount_out, amount_in_max, &caller, false,
        ));
        let amount_in = dec_u256(&out);

        // Refund unused input.
        if amount_in < amount_in_max {
            push_token(&path[0], &caller, amount_in_max - amount_in);
        }

        emit_swap(&caller, amount_in, amount_out);
        Ok(amount_in)
    }

    // ── Quotes (read-only, no approval needed) ───────────────────────────

    #[cfg_attr(not(test), pvm_contract_macros::method)]
    pub fn get_amount_out(asset_in: Vec<u8>, asset_out: Vec<u8>, amount_in: U256) -> U256 {
        let out = dex_call(&build_quote_exact_in(&asset_in, &asset_out, amount_in, true));
        dec_u256(&out)
    }

    #[cfg_attr(not(test), pvm_contract_macros::method)]
    pub fn get_amount_in(asset_in: Vec<u8>, asset_out: Vec<u8>, amount_out: U256) -> U256 {
        let out = dex_call(&build_quote_exact_out(&asset_in, &asset_out, amount_out, true));
        dec_u256(&out)
    }

    // ── Pool management ──────────────────────────────────────────────────

    #[cfg_attr(not(test), pvm_contract_macros::method)]
    pub fn create_pool(asset1: Vec<u8>, asset2: Vec<u8>) -> Result<(), Error> {
        let caller = caller_addr();
        dex_call(&build_create_pool(&asset1, &asset2));
        emit_pool_created(&caller);
        Ok(())
    }

    #[cfg_attr(not(test), pvm_contract_macros::method)]
    pub fn add_liquidity(
        asset1: Vec<u8>,
        asset2: Vec<u8>,
        amount1_desired: U256,
        amount2_desired: U256,
        amount1_min: U256,
        amount2_min: U256,
    ) -> Result<U256, Error> {
        let caller = caller_addr();
        let me = self_addr();

        // Pull both tokens from caller.
        pull_token(&asset1, &caller, &me, amount1_desired);
        pull_token(&asset2, &caller, &me, amount2_desired);

        // Add liquidity — LP tokens go to caller.
        let out = dex_call(&build_add_liquidity(
            &asset1, &asset2,
            amount1_desired, amount2_desired,
            amount1_min, amount2_min,
            &caller,
        ));
        let lp = dec_u256(&out);

        // Refund any tokens the pool didn't consume.
        sweep_token(&asset1, &caller, &me);
        sweep_token(&asset2, &caller, &me);

        emit_liquidity_added(&caller, amount1_desired, amount2_desired);
        Ok(lp)
    }

    /// Remove liquidity from a pool. LP tokens must already be in this
    /// contract (transfer them before calling). The withdrawn assets are
    /// sent directly to the caller.
    #[cfg_attr(not(test), pvm_contract_macros::method)]
    pub fn remove_liquidity(
        asset1: Vec<u8>,
        asset2: Vec<u8>,
        lp_token_burn: U256,
        amount1_min: U256,
        amount2_min: U256,
    ) -> Result<(U256, U256), Error> {
        let caller = caller_addr();
        let out = dex_call(&build_remove_liquidity(
            &asset1, &asset2,
            lp_token_burn, amount1_min, amount2_min,
            &caller,
        ));
        let a1 = dec_u256(&out);
        let a2 = dec_u256(&out[32..]);
        emit_liquidity_removed(&caller, lp_token_burn);
        Ok((a1, a2))
    }

    #[cfg_attr(not(test), pvm_contract_macros::method)]
    pub fn create_pool_and_add(
        asset1: Vec<u8>,
        asset2: Vec<u8>,
        amount1_desired: U256,
        amount2_desired: U256,
        amount1_min: U256,
        amount2_min: U256,
    ) -> Result<U256, Error> {
        let caller = caller_addr();
        let me = self_addr();

        pull_token(&asset1, &caller, &me, amount1_desired);
        pull_token(&asset2, &caller, &me, amount2_desired);

        dex_call(&build_create_pool(&asset1, &asset2));

        let out = dex_call(&build_add_liquidity(
            &asset1, &asset2,
            amount1_desired, amount2_desired,
            amount1_min, amount2_min,
            &caller,
        ));
        let lp = dec_u256(&out);

        sweep_token(&asset1, &caller, &me);
        sweep_token(&asset2, &caller, &me);

        emit_pool_created(&caller);
        emit_liquidity_added(&caller, amount1_desired, amount2_desired);
        Ok(lp)
    }

    #[cfg_attr(not(test), pvm_contract_macros::fallback)]
    pub fn fallback() -> Result<(), Error> {
        Err(Error::UnknownSelector)
    }

    // ── Token management (pull / push / sweep) ───────────────────────────

    /// Pull `amount` of `asset` from `from` to `to` via ERC20 `transferFrom`.
    /// Native assets (SCALE prefix 0x00) are expected as msg.value — no pull.
    fn pull_token(asset: &[u8], from: &[u8; 20], to: &[u8; 20], amount: U256) {
        if let Some(erc20) = erc20_of(asset) {
            erc20_call(&erc20, &build_transfer_from(from, to, amount));
        }
    }

    /// Transfer `amount` of `asset` from this contract to `to`.
    fn push_token(asset: &[u8], to: &[u8; 20], amount: U256) {
        if let Some(erc20) = erc20_of(asset) {
            erc20_call(&erc20, &build_erc20_transfer(to, amount));
        }
    }

    /// Sweep: send any remaining balance of `asset` from `me` back to `to`.
    fn sweep_token(asset: &[u8], to: &[u8; 20], me: &[u8; 20]) {
        if let Some(erc20) = erc20_of(asset) {
            let out = erc20_call(&erc20, &build_balance_of(me));
            let bal = dec_u256(&out);
            if bal > U256::ZERO {
                erc20_call(&erc20, &build_erc20_transfer(to, bal));
            }
        }
    }

    /// Map SCALE-encoded `NativeOrWithId` to its ERC20 precompile H160.
    /// Returns `None` for the native asset (no ERC20 wrapper).
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
        if v { w[31] = 1; }
        w
    }

    fn dec_u256(d: &[u8]) -> U256 {
        if d.len() < 32 {
            return U256::ZERO;
        }
        U256::from_be_bytes::<32>(d[0..32].try_into().unwrap())
    }

    /// Call the asset-conversion precompile. Reverts with
    /// `PrecompileCallFailed()` on failure.
    fn dex_call(calldata: &[u8]) -> [u8; 128] {
        do_call(&PRECOMPILE, calldata, b"PrecompileCallFailed()")
    }

    /// Call an ERC20 precompile. Reverts with `TransferFromFailed()` on failure.
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

    fn build_balance_of(account: &[u8; 20]) -> Vec<u8> {
        let s = sel(b"balanceOf(address)");
        let mut buf = vec![0u8; 4 + 32];
        buf[0..4].copy_from_slice(&s);
        buf[4..36].copy_from_slice(&enc_addr(account));
        buf
    }

    // ── Precompile calldata builders ─────────────────────────────────────

    fn build_swap_exact_in(
        path: &[&[u8]], amount_in: U256, amount_out_min: U256,
        send_to: &[u8; 20], keep_alive: bool,
    ) -> Vec<u8> {
        let s = sel(b"swapExactTokensForTokens(bytes[],uint256,uint256,address,bool)");
        let path_data_size = bytes_array_encoded_size(path);
        let total = 4 + 5 * 32 + path_data_size;
        let mut buf = vec![0u8; total];
        buf[0..4].copy_from_slice(&s);
        let mut pos = 4;

        let mut off = [0u8; 32];
        off[28..32].copy_from_slice(&160u32.to_be_bytes());
        buf[pos..pos + 32].copy_from_slice(&off);
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&enc_u256(amount_in));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&enc_u256(amount_out_min));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&enc_addr(send_to));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&enc_bool(keep_alive));
        pos += 32;
        encode_bytes_array(path, &mut buf, pos);
        buf
    }

    fn build_swap_exact_out(
        path: &[&[u8]], amount_out: U256, amount_in_max: U256,
        send_to: &[u8; 20], keep_alive: bool,
    ) -> Vec<u8> {
        let s = sel(b"swapTokensForExactTokens(bytes[],uint256,uint256,address,bool)");
        let path_data_size = bytes_array_encoded_size(path);
        let total = 4 + 5 * 32 + path_data_size;
        let mut buf = vec![0u8; total];
        buf[0..4].copy_from_slice(&s);
        let mut pos = 4;

        let mut off = [0u8; 32];
        off[28..32].copy_from_slice(&160u32.to_be_bytes());
        buf[pos..pos + 32].copy_from_slice(&off);
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&enc_u256(amount_out));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&enc_u256(amount_in_max));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&enc_addr(send_to));
        pos += 32;
        buf[pos..pos + 32].copy_from_slice(&enc_bool(keep_alive));
        pos += 32;
        encode_bytes_array(path, &mut buf, pos);
        buf
    }

    /// Common encoder: selector + two `bytes` params + N static words.
    fn enc_two_bytes(
        sig: &[u8; 4], a1: &[u8], a2: &[u8], static_words: &[[u8; 32]],
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

    fn build_quote_exact_in(a_in: &[u8], a_out: &[u8], amount: U256, fee: bool) -> Vec<u8> {
        let s = sel(b"quoteExactTokensForTokens(bytes,bytes,uint256,bool)");
        enc_two_bytes(&s, a_in, a_out, &[enc_u256(amount), enc_bool(fee)])
    }

    fn build_quote_exact_out(a_in: &[u8], a_out: &[u8], amount: U256, fee: bool) -> Vec<u8> {
        let s = sel(b"quoteTokensForExactTokens(bytes,bytes,uint256,bool)");
        enc_two_bytes(&s, a_in, a_out, &[enc_u256(amount), enc_bool(fee)])
    }

    fn build_create_pool(a1: &[u8], a2: &[u8]) -> Vec<u8> {
        let s = sel(b"createPool(bytes,bytes)");
        enc_two_bytes(&s, a1, a2, &[])
    }

    fn build_add_liquidity(
        a1: &[u8], a2: &[u8], d1: U256, d2: U256, m1: U256, m2: U256, mint_to: &[u8; 20],
    ) -> Vec<u8> {
        let s = sel(b"addLiquidity(bytes,bytes,uint256,uint256,uint256,uint256,address)");
        enc_two_bytes(&s, a1, a2, &[
            enc_u256(d1), enc_u256(d2), enc_u256(m1), enc_u256(m2),
            enc_addr(mint_to),
        ])
    }

    fn build_remove_liquidity(
        a1: &[u8], a2: &[u8], lp: U256, m1: U256, m2: U256, to: &[u8; 20],
    ) -> Vec<u8> {
        let s = sel(b"removeLiquidity(bytes,bytes,uint256,uint256,uint256,address)");
        enc_two_bytes(&s, a1, a2, &[
            enc_u256(lp), enc_u256(m1), enc_u256(m2), enc_addr(to),
        ])
    }

    // ── Events ───────────────────────────────────────────────────────────

    fn emit_swap(sender: &[u8; 20], amount_in: U256, amount_out: U256) {
        let mut sig = [0u8; 32];
        api::hash_keccak_256(b"SwapExecuted(address,uint256,uint256)", &mut sig);
        let mut t = [0u8; 32];
        t[12..32].copy_from_slice(sender);
        let mut data = [0u8; 64];
        data[0..32].copy_from_slice(&enc_u256(amount_in));
        data[32..64].copy_from_slice(&enc_u256(amount_out));
        api::deposit_event(&[sig, t], &data);
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
        data[0..32].copy_from_slice(&enc_u256(a1));
        data[32..64].copy_from_slice(&enc_u256(a2));
        api::deposit_event(&[sig, t], &data);
    }

    fn emit_liquidity_removed(provider: &[u8; 20], lp: U256) {
        let mut sig = [0u8; 32];
        api::hash_keccak_256(b"LiquidityRemoved(address,uint256)", &mut sig);
        let mut t = [0u8; 32];
        t[12..32].copy_from_slice(provider);
        api::deposit_event(&[sig, t], &enc_u256(lp));
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
        let mut out = [0u8; 128];
        out[..32].copy_from_slice(&U256::from(1000u64).to_be_bytes::<32>());
        mock_api::set_call_output(&out);
    }

    /// Path of pallet-assets tokens (WithId SCALE format).
    fn token_path(n: usize) -> Vec<Vec<u8>> {
        (0..n).map(|i| vec![0x01, (i + 1) as u8, 0, 0, 0]).collect()
    }

    /// Native → Token path.
    fn native_path() -> Vec<Vec<u8>> {
        vec![vec![0x00], vec![0x01, 1, 0, 0, 0]]
    }

    // -- ERC20 address mapping --

    #[test]
    fn erc20_of_native_returns_none() {
        assert_eq!(erc20_of(&[0x00]), None);
    }

    #[test]
    fn erc20_of_empty_returns_none() {
        assert_eq!(erc20_of(&[]), None);
    }

    #[test]
    fn erc20_of_asset_id_1() {
        let addr = erc20_of(&[0x01, 1, 0, 0, 0]).unwrap();
        assert_eq!(addr[0..4], [0, 0, 0, 1]);
        assert_eq!(addr[4..16], [0; 12]);
        assert_eq!(addr[16..18], [0x01, 0x20]);
        assert_eq!(addr[18..20], [0, 0]);
    }

    #[test]
    fn erc20_of_asset_id_2() {
        let addr = erc20_of(&[0x01, 2, 0, 0, 0]).unwrap();
        assert_eq!(addr[0..4], [0, 0, 0, 2]);
        assert_eq!(addr[16..18], [0x01, 0x20]);
    }

    // -- PathTooLong --

    #[test]
    fn swap_exact_in_rejects_long_path() {
        setup();
        let result = swap_exact_in(token_path(9), U256::from(100u64), U256::ZERO);
        assert_eq!(result, Err(Error::PathTooLong));
    }

    #[test]
    fn swap_exact_out_rejects_long_path() {
        setup();
        let result = swap_exact_out(token_path(9), U256::from(100u64), U256::MAX);
        assert_eq!(result, Err(Error::PathTooLong));
    }

    // -- Swap happy path --

    #[test]
    fn swap_exact_in_token_pulls_and_swaps() {
        setup();
        let result = swap_exact_in(token_path(2), U256::from(100u64), U256::ZERO);
        assert_eq!(result, Ok(U256::from(1000u64)));
        // 1 ERC20 transferFrom + 1 precompile swap
        assert_eq!(mock_api::call_count(), 2);
        assert_eq!(mock_api::event_count(), 1);
    }

    #[test]
    fn swap_exact_in_native_skips_pull() {
        setup();
        let result = swap_exact_in(native_path(), U256::from(100u64), U256::ZERO);
        assert_eq!(result, Ok(U256::from(1000u64)));
        // No ERC20 pull for native input, only precompile swap
        assert_eq!(mock_api::call_count(), 1);
        assert_eq!(mock_api::event_count(), 1);
    }

    #[test]
    fn swap_exact_out_refunds_excess() {
        setup();
        // Mock returns amount_in = 1000; amount_in_max = 2000 → refund 1000
        let result = swap_exact_out(token_path(2), U256::from(500u64), U256::from(2000u64));
        assert_eq!(result, Ok(U256::from(1000u64)));
        // 1 pull + 1 swap + 1 refund
        assert_eq!(mock_api::call_count(), 3);
    }

    #[test]
    fn swap_exact_out_no_refund_when_exact() {
        setup();
        // Mock returns amount_in = 1000 = amount_in_max → no refund
        let result = swap_exact_out(token_path(2), U256::from(500u64), U256::from(1000u64));
        assert_eq!(result, Ok(U256::from(1000u64)));
        // 1 pull + 1 swap, no refund
        assert_eq!(mock_api::call_count(), 2);
    }

    #[test]
    fn swap_exact_in_at_max_path_length() {
        setup();
        let result = swap_exact_in(token_path(8), U256::from(50u64), U256::ZERO);
        assert!(result.is_ok());
    }

    // -- Revert on failure --

    #[test]
    #[should_panic(expected = "contract reverted")]
    fn swap_reverts_on_precompile_failure() {
        setup();
        mock_api::set_call_should_fail(true);
        // Use native input so first call is the precompile, not ERC20
        let _ = swap_exact_in(native_path(), U256::from(100u64), U256::ZERO);
    }

    #[test]
    #[should_panic(expected = "contract reverted")]
    fn swap_reverts_on_erc20_failure() {
        setup();
        mock_api::set_call_should_fail(true);
        // Token input — ERC20 transferFrom is the first call and will fail
        let _ = swap_exact_in(token_path(2), U256::from(100u64), U256::ZERO);
    }

    // -- Liquidity --

    #[test]
    fn add_liquidity_pulls_and_sweeps() {
        setup();
        let a1 = vec![0x01, 1, 0, 0, 0];
        let a2 = vec![0x01, 2, 0, 0, 0];
        let result = add_liquidity(
            a1, a2,
            U256::from(1000u64), U256::from(1000u64),
            U256::ZERO, U256::ZERO,
        );
        assert!(result.is_ok());
        // 2 pulls + 1 addLiquidity + 2*(balanceOf + transfer) = 7 calls
        // (balanceOf returns mock value 1000 > 0, so transfer fires)
        assert_eq!(mock_api::call_count(), 7);
        assert_eq!(mock_api::event_count(), 1);
    }

    #[test]
    fn create_pool_and_add_emits_two_events() {
        setup();
        let a1 = vec![0x01, 1, 0, 0, 0];
        let a2 = vec![0x01, 2, 0, 0, 0];
        let _ = create_pool_and_add(
            a1, a2,
            U256::from(1000u64), U256::from(1000u64),
            U256::ZERO, U256::ZERO,
        );
        // pool_created + liquidity_added
        assert_eq!(mock_api::event_count(), 2);
    }
}
