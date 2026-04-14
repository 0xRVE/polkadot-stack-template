use crate::{
	AccountId, AssetsConfig, BalancesConfig, CollatorSelectionConfig, ParachainInfoConfig,
	PolkadotXcmConfig, RuntimeGenesisConfig, SessionConfig, SessionKeys, SudoConfig,
	EXISTENTIAL_DEPOSIT,
};

use alloc::{vec, vec::Vec};

use polkadot_sdk::{staging_xcm as xcm, *};

use cumulus_primitives_core::ParaId;
use frame_support::build_struct_json_patch;
use parachains_common::AuraId;
use serde_json::Value;
use sp_genesis_builder::PresetId;
use sp_keyring::Sr25519Keyring;
use xcm::prelude::XCM_VERSION;

/// The default XCM version to set in genesis config.
const SAFE_XCM_VERSION: u32 = XCM_VERSION;
/// Parachain id used for genesis config presets.
pub const PARACHAIN_ID: u32 = 1000;

/// Generate the session keys from individual elements.
pub fn template_session_keys(keys: AuraId) -> SessionKeys {
	SessionKeys { aura: keys }
}

/// Test asset IDs for the DEX.
pub const TEST_ASSET_A: u32 = 1;
pub const TEST_ASSET_B: u32 = 2;

fn testnet_genesis(
	invulnerables: Vec<(AccountId, AuraId)>,
	endowed_accounts: Vec<AccountId>,
	root: AccountId,
	id: ParaId,
) -> Value {
	let alice = Sr25519Keyring::Alice.to_account_id();

	build_struct_json_patch!(RuntimeGenesisConfig {
		balances: BalancesConfig {
			balances: endowed_accounts
				.iter()
				.cloned()
				.map(|k| (k, 1u128 << 60))
				.collect::<Vec<_>>(),
		},
		parachain_info: ParachainInfoConfig { parachain_id: id },
		collator_selection: CollatorSelectionConfig {
			invulnerables: invulnerables.iter().cloned().map(|(acc, _)| acc).collect::<Vec<_>>(),
			candidacy_bond: EXISTENTIAL_DEPOSIT * 16,
		},
		session: SessionConfig {
			keys: invulnerables
				.into_iter()
				.map(|(acc, aura)| { (acc.clone(), acc, template_session_keys(aura),) })
				.collect::<Vec<_>>(),
		},
		polkadot_xcm: PolkadotXcmConfig { safe_xcm_version: Some(SAFE_XCM_VERSION) },
		sudo: SudoConfig { key: Some(root) },
		assets: AssetsConfig {
			assets: vec![
				(TEST_ASSET_A, alice.clone(), true, 1),
				(TEST_ASSET_B, alice.clone(), true, 1),
			],
			metadata: vec![
				(TEST_ASSET_A, b"Test Token A".to_vec(), b"TSTA".to_vec(), 12),
				(TEST_ASSET_B, b"Test Token B".to_vec(), b"TSTB".to_vec(), 12),
			],
			accounts: endowed_accounts
				.iter()
				.cloned()
				.flat_map(|acc| {
					vec![(TEST_ASSET_A, acc.clone(), 1u128 << 60), (TEST_ASSET_B, acc, 1u128 << 60)]
				})
				.collect(),
		},
	})
}

fn local_testnet_genesis() -> Value {
	testnet_genesis(
		vec![
			(Sr25519Keyring::Alice.to_account_id(), Sr25519Keyring::Alice.public().into()),
			(Sr25519Keyring::Bob.to_account_id(), Sr25519Keyring::Bob.public().into()),
		],
		Sr25519Keyring::well_known().map(|k| k.to_account_id()).collect(),
		Sr25519Keyring::Alice.to_account_id(),
		PARACHAIN_ID.into(),
	)
}

/// Ethereum dev accounts (Alith, Baltathar, Charleth) with 0xEE padding to 32 bytes.
/// These are the standard dev accounts recognized by the eth-rpc adapter.
fn eth_dev_accounts() -> Vec<AccountId> {
	use sp_core::crypto::AccountId32;
	[
		// Alith
		hex_literal::hex!("f24ff3a9cf04c71dbc94d0b566f7a27b94566caceeeeeeeeeeeeeeeeeeeeeeee"),
		// Baltathar
		hex_literal::hex!("3cd0a705a2dc65e5b1e1205896baa2be8a07c6e0eeeeeeeeeeeeeeeeeeeeeeee"),
		// Charleth
		hex_literal::hex!("798d4ba9baf0064ec19eb4f0a1a45785ae9d6dfceeeeeeeeeeeeeeeeeeeeeeee"),
	]
	.into_iter()
	.map(AccountId32::from)
	.collect()
}

fn development_config_genesis() -> Value {
	let mut endowed: Vec<AccountId> =
		Sr25519Keyring::well_known().map(|k| k.to_account_id()).collect();
	endowed.extend(eth_dev_accounts());

	testnet_genesis(
		vec![
			(Sr25519Keyring::Alice.to_account_id(), Sr25519Keyring::Alice.public().into()),
			(Sr25519Keyring::Bob.to_account_id(), Sr25519Keyring::Bob.public().into()),
		],
		endowed,
		Sr25519Keyring::Alice.to_account_id(),
		PARACHAIN_ID.into(),
	)
}

/// Provides the JSON representation of predefined genesis config for given `id`.
pub fn get_preset(id: &PresetId) -> Option<vec::Vec<u8>> {
	let patch = match id.as_ref() {
		sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET => local_testnet_genesis(),
		sp_genesis_builder::DEV_RUNTIME_PRESET => development_config_genesis(),
		_ => return None,
	};
	Some(
		serde_json::to_string(&patch)
			.expect("serialization to json is expected to work. qed.")
			.into_bytes(),
	)
}

/// List of supported presets.
pub fn preset_names() -> Vec<PresetId> {
	vec![
		PresetId::from(sp_genesis_builder::DEV_RUNTIME_PRESET),
		PresetId::from(sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET),
	]
}
