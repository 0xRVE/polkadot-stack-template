//! Pure ABI-encoding helpers for the DEX router contract.
//!
//! Extracted into a library target so they can be tested natively without the
//! PolkaVM toolchain.

#![cfg_attr(not(feature = "abi-gen"), no_std)]

extern crate alloc;

use alloc::vec;

/// Maximum number of assets in a swap path. The runtime limits this to 4
/// (`MaxSwapPathLength`), but we cap at 8 to guard against allocator abuse
/// in the bump-allocator contract.
pub const MAX_SWAP_PATH: usize = 8;

/// Returns the ABI-encoded byte size of a `bytes[]` array.
pub fn bytes_array_encoded_size(items: &[&[u8]]) -> usize {
    let n = items.len();
    let mut size = 32 + n * 32;
    for item in items {
        size += 32 + ((item.len() + 31) / 32) * 32;
    }
    size
}

/// ABI-encodes a `bytes[]` array into `buf` starting at `offset`.
pub fn encode_bytes_array(items: &[&[u8]], buf: &mut [u8], offset: usize) {
    let n = items.len();
    let mut pos = offset;

    let mut len_word = [0u8; 32];
    len_word[31] = n as u8;
    buf[pos..pos + 32].copy_from_slice(&len_word);
    pos += 32;

    let offsets_start = pos;
    let mut offsets = vec![0usize; n];
    let mut data_pos = offsets_start + n * 32;

    for i in 0..n {
        offsets[i] = data_pos - offsets_start;
        let item = items[i];
        let mut item_len = [0u8; 32];
        item_len[28..32].copy_from_slice(&(item.len() as u32).to_be_bytes());
        buf[data_pos..data_pos + 32].copy_from_slice(&item_len);
        data_pos += 32;
        buf[data_pos..data_pos + item.len()].copy_from_slice(item);
        let padded = ((item.len() + 31) / 32) * 32;
        for j in item.len()..padded {
            buf[data_pos + j] = 0;
        }
        data_pos += padded;
    }

    for i in 0..n {
        let mut off_word = [0u8; 32];
        off_word[28..32].copy_from_slice(&(offsets[i] as u32).to_be_bytes());
        buf[offsets_start + i * 32..offsets_start + i * 32 + 32].copy_from_slice(&off_word);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;

    /// Read the low 4 bytes of an ABI word at byte offset `off`.
    fn read_word(buf: &[u8], off: usize) -> usize {
        u32::from_be_bytes(buf[off + 28..off + 32].try_into().unwrap()) as usize
    }

    fn encode(items: &[&[u8]]) -> Vec<u8> {
        let size = bytes_array_encoded_size(items);
        let mut buf = vec![0u8; size];
        encode_bytes_array(items, &mut buf, 0);
        buf
    }

    fn make_items(n: usize) -> Vec<Vec<u8>> {
        (0..n).map(|i| vec![i as u8; 20]).collect()
    }

    // -- size calculation --

    #[test]
    fn size_empty() {
        assert_eq!(bytes_array_encoded_size(&[]), 32);
    }

    #[test]
    fn size_single_item() {
        let item = [0u8; 20];
        // 32 (length) + 32 (offset) + 32 (item-length) + 32 (data padded)
        assert_eq!(bytes_array_encoded_size(&[&item[..]]), 128);
    }

    // -- round-trip encoding --

    #[test]
    fn encode_empty() {
        let buf = encode(&[]);
        assert_eq!(read_word(&buf, 0), 0);
    }

    #[test]
    fn encode_single_item_roundtrip() {
        let item = b"hello";
        let buf = encode(&[&item[..]]);

        assert_eq!(read_word(&buf, 0), 1);
        let data_off = read_word(&buf, 32);
        let item_len = read_word(&buf, 32 + data_off);
        assert_eq!(item_len, 5);
        assert_eq!(&buf[32 + data_off + 32..32 + data_off + 32 + 5], b"hello");
    }

    #[test]
    fn encode_multiple_items_roundtrip() {
        let a = [1u8; 20];
        let b = [2u8; 32];
        let c = [3u8; 5];
        let items: &[&[u8]] = &[&a, &b, &c];
        let buf = encode(items);

        assert_eq!(read_word(&buf, 0), 3);
        for (idx, item) in items.iter().enumerate() {
            let off = read_word(&buf, 32 + idx * 32);
            let len = read_word(&buf, 32 + off);
            assert_eq!(len, item.len());
            assert_eq!(&buf[32 + off + 32..32 + off + 32 + len], *item);
        }
    }

    // -- the bug: paths > 8 must not panic --

    #[test]
    fn encode_8_items() {
        let items = make_items(8);
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let buf = encode(&refs);
        assert_eq!(read_word(&buf, 0), 8);
    }

    #[test]
    fn encode_9_items() {
        let items = make_items(9);
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let buf = encode(&refs);
        assert_eq!(read_word(&buf, 0), 9);
    }

    #[test]
    fn encode_16_items() {
        let items = make_items(16);
        let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
        let buf = encode(&refs);
        assert_eq!(read_word(&buf, 0), 16);
    }

    // -- predicted size matches actual buffer --

    #[test]
    fn encoded_size_matches_buffer() {
        for n in 0..=12 {
            let items = make_items(n);
            let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
            let predicted = bytes_array_encoded_size(&refs);
            let buf = encode(&refs);
            assert_eq!(predicted, buf.len(), "size mismatch for {n} items");
        }
    }

    // -- non-zero offset --

    #[test]
    fn encode_with_offset() {
        let item = b"test";
        let items: &[&[u8]] = &[&item[..]];
        let size = bytes_array_encoded_size(items);
        let prefix = 64;
        let mut buf = vec![0u8; prefix + size];
        encode_bytes_array(items, &mut buf, prefix);

        assert_eq!(read_word(&buf, prefix), 1);
        assert!(buf[..prefix].iter().all(|&b| b == 0));
    }
}
