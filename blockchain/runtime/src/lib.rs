#![cfg_attr(not(feature = "std"), no_std)]
#![recursion_limit = "256"]

#[cfg(feature = "std")]
include!(concat!(env!("OUT_DIR"), "/wasm_binary.rs"));

#[cfg(feature = "runtime-benchmarks")]
mod benchmarks;
pub mod configs;
mod genesis_config_presets;
#[cfg(test)]
mod tests;
mod weights;

extern crate alloc;
use alloc::{vec, vec::Vec};
use smallvec::smallvec;

use polkadot_sdk::{staging_parachain_info as parachain_info, *};

use sp_api::impl_runtime_apis;
use sp_runtime::{
	generic, impl_opaque_keys,
	traits::{BlakeTwo256, IdentifyAccount, Verify},
	MultiSignature,
};

#[cfg(feature = "std")]
use sp_version::NativeVersion;
use sp_version::RuntimeVersion;

use frame_support::weights::{constants::WEIGHT_REF_TIME_PER_SECOND, Weight};
pub use sp_consensus_aura::sr25519::AuthorityId as AuraId;
pub use sp_runtime::{MultiAddress, Perbill, Permill};

pub use genesis_config_presets::PARACHAIN_ID;

pub type Signature = MultiSignature;
pub type AccountId = <<Signature as Verify>::Signer as IdentifyAccount>::AccountId;
pub type Balance = u128;
pub type Nonce = u32;
pub type Hash = sp_core::H256;
pub type BlockNumber = u32;
pub type Address = MultiAddress<AccountId, ()>;
pub type Header = generic::Header<BlockNumber, BlakeTwo256>;
pub type Block = generic::Block<Header, UncheckedExtrinsic>;
pub type SignedBlock = generic::SignedBlock<Block>;
pub type BlockId = generic::BlockId<Block>;

pub type TxExtension = cumulus_pallet_weight_reclaim::StorageWeightReclaim<
	Runtime,
	(
		frame_system::CheckNonZeroSender<Runtime>,
		frame_system::CheckSpecVersion<Runtime>,
		frame_system::CheckTxVersion<Runtime>,
		frame_system::CheckGenesis<Runtime>,
		frame_system::CheckEra<Runtime>,
		frame_system::CheckNonce<Runtime>,
		frame_system::CheckWeight<Runtime>,
		pallet_transaction_payment::ChargeTransactionPayment<Runtime>,
		frame_metadata_hash_extension::CheckMetadataHash<Runtime>,
		pallet_revive::evm::tx_extension::SetOrigin<Runtime>,
	),
>;

/// Default extensions applied to Ethereum transactions.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EthExtraImpl;

impl pallet_revive::evm::runtime::EthExtra for EthExtraImpl {
	type Config = Runtime;
	type Extension = TxExtension;

	fn get_eth_extension(nonce: u32, tip: Balance) -> Self::Extension {
		(
			frame_system::CheckNonZeroSender::<Runtime>::new(),
			frame_system::CheckSpecVersion::<Runtime>::new(),
			frame_system::CheckTxVersion::<Runtime>::new(),
			frame_system::CheckGenesis::<Runtime>::new(),
			frame_system::CheckMortality::from(generic::Era::Immortal),
			frame_system::CheckNonce::<Runtime>::from(nonce),
			frame_system::CheckWeight::<Runtime>::new(),
			pallet_transaction_payment::ChargeTransactionPayment::<Runtime>::from(tip),
			frame_metadata_hash_extension::CheckMetadataHash::<Runtime>::new(false),
			pallet_revive::evm::tx_extension::SetOrigin::<Runtime>::new_from_eth_transaction(),
		)
			.into()
	}
}

/// Unchecked extrinsic type supporting both Substrate and Ethereum transactions.
pub type UncheckedExtrinsic =
	pallet_revive::evm::runtime::UncheckedExtrinsic<Address, Signature, EthExtraImpl>;

pub type Executive = frame_executive::Executive<
	Runtime,
	Block,
	frame_system::ChainContext<Runtime>,
	Runtime,
	AllPalletsWithSystem,
>;

use frame_support::weights::{
	WeightToFeeCoefficient, WeightToFeeCoefficients, WeightToFeePolynomial,
};
use weights::ExtrinsicBaseWeight;

pub struct WeightToFee;
impl WeightToFeePolynomial for WeightToFee {
	type Balance = Balance;
	fn polynomial() -> WeightToFeeCoefficients<Self::Balance> {
		let p = MILLI_UNIT / 10;
		let q = 100 * Balance::from(ExtrinsicBaseWeight::get().ref_time());
		smallvec![WeightToFeeCoefficient {
			degree: 1,
			negative: false,
			coeff_frac: Perbill::from_rational(p % q, q),
			coeff_integer: p / q,
		}]
	}
}

/// Opaque types for the node-side (non-WASM) code.
///
/// Re-exports block/header types with `OpaqueExtrinsic` so the node service
/// layer can handle serialised extrinsics without full runtime type info.
pub mod opaque {
	use super::*;
	pub use sp_runtime::OpaqueExtrinsic as UncheckedExtrinsic;
	use sp_runtime::{
		generic,
		traits::{BlakeTwo256, Hash as HashT},
	};

	pub type Header = generic::Header<BlockNumber, BlakeTwo256>;
	pub type Block = generic::Block<Header, UncheckedExtrinsic>;
	pub type BlockId = generic::BlockId<Block>;
	pub type Hash = <BlakeTwo256 as HashT>::Output;
}

impl_opaque_keys! {
	pub struct SessionKeys {
		pub aura: Aura,
	}
}

// VERSION is defined after the impl_runtime_apis_plus_revive_traits! macro at the
// bottom of this file, because that macro generates RUNTIME_API_VERSIONS.

mod block_times {
	pub const MILLI_SECS_PER_BLOCK: u64 = 6000;
	pub const SLOT_DURATION: u64 = MILLI_SECS_PER_BLOCK;
}
pub use block_times::*;

pub const MINUTES: BlockNumber = 60_000 / (MILLI_SECS_PER_BLOCK as BlockNumber);
pub const HOURS: BlockNumber = MINUTES * 60;
pub const DAYS: BlockNumber = HOURS * 24;

pub const UNIT: Balance = 1_000_000_000_000;
pub const MILLI_UNIT: Balance = 1_000_000_000;
pub const MICRO_UNIT: Balance = 1_000_000;

pub const EXISTENTIAL_DEPOSIT: Balance = MILLI_UNIT;

const AVERAGE_ON_INITIALIZE_RATIO: Perbill = Perbill::from_percent(5);
const NORMAL_DISPATCH_RATIO: Perbill = Perbill::from_percent(75);

const MAXIMUM_BLOCK_WEIGHT: Weight = Weight::from_parts(
	WEIGHT_REF_TIME_PER_SECOND.saturating_mul(2),
	cumulus_primitives_core::relay_chain::MAX_POV_SIZE as u64,
);

mod async_backing_params {
	pub(crate) const UNINCLUDED_SEGMENT_CAPACITY: u32 = 3;
	pub(crate) const BLOCK_PROCESSING_VELOCITY: u32 = 1;
	pub(crate) const RELAY_CHAIN_SLOT_DURATION_MILLIS: u32 = 6000;
}
pub(crate) use async_backing_params::*;

type ConsensusHook = cumulus_pallet_aura_ext::FixedVelocityConsensusHook<
	Runtime,
	RELAY_CHAIN_SLOT_DURATION_MILLIS,
	BLOCK_PROCESSING_VELOCITY,
	UNINCLUDED_SEGMENT_CAPACITY,
>;

#[cfg(feature = "std")]
pub fn native_version() -> NativeVersion {
	NativeVersion { runtime_version: VERSION, can_author_with: Default::default() }
}

#[frame_support::runtime]
mod runtime {
	#[runtime::runtime]
	#[runtime::derive(
		RuntimeCall,
		RuntimeEvent,
		RuntimeError,
		RuntimeOrigin,
		RuntimeFreezeReason,
		RuntimeHoldReason,
		RuntimeSlashReason,
		RuntimeLockId,
		RuntimeTask,
		RuntimeViewFunction
	)]
	pub struct Runtime;

	#[runtime::pallet_index(0)]
	pub type System = frame_system;
	#[runtime::pallet_index(1)]
	pub type ParachainSystem = cumulus_pallet_parachain_system;
	#[runtime::pallet_index(2)]
	pub type Timestamp = pallet_timestamp;
	#[runtime::pallet_index(3)]
	pub type ParachainInfo = parachain_info;
	#[runtime::pallet_index(4)]
	pub type WeightReclaim = cumulus_pallet_weight_reclaim;

	#[runtime::pallet_index(10)]
	pub type Balances = pallet_balances;
	#[runtime::pallet_index(11)]
	pub type TransactionPayment = pallet_transaction_payment;

	#[runtime::pallet_index(15)]
	pub type Sudo = pallet_sudo;

	#[runtime::pallet_index(20)]
	pub type Authorship = pallet_authorship;
	#[runtime::pallet_index(21)]
	pub type CollatorSelection = pallet_collator_selection;
	#[runtime::pallet_index(22)]
	pub type Session = pallet_session;
	#[runtime::pallet_index(23)]
	pub type Aura = pallet_aura;
	#[runtime::pallet_index(24)]
	pub type AuraExt = cumulus_pallet_aura_ext;

	#[runtime::pallet_index(30)]
	pub type XcmpQueue = cumulus_pallet_xcmp_queue;
	#[runtime::pallet_index(31)]
	pub type PolkadotXcm = pallet_xcm;
	#[runtime::pallet_index(32)]
	pub type CumulusXcm = cumulus_pallet_xcm;
	#[runtime::pallet_index(33)]
	pub type MessageQueue = pallet_message_queue;

	#[runtime::pallet_index(40)]
	pub type Statement = pallet_statement;

	#[runtime::pallet_index(50)]
	pub type TemplatePallet = pallet_template;

	// Fungible assets + DEX
	#[runtime::pallet_index(60)]
	pub type Assets = pallet_assets;
	#[runtime::pallet_index(61)]
	pub type AssetConversion = pallet_asset_conversion;
	#[runtime::pallet_index(62)]
	pub type PoolAssets = pallet_assets<Instance2>;

	// Smart contracts (EVM + PVM via pallet-revive)
	#[runtime::pallet_index(90)]
	pub type Revive = pallet_revive;
}

// Runtime APIs including pallet-revive's ReviveApi (26+ methods for Ethereum RPC compatibility).
// This macro also implements SetWeightLimit for RuntimeCall.
pallet_revive::impl_runtime_apis_plus_revive_traits!(
	Runtime,
	Revive,
	Executive,
	EthExtraImpl,

	impl sp_consensus_aura::AuraApi<Block, AuraId> for Runtime {
		fn slot_duration() -> sp_consensus_aura::SlotDuration {
			sp_consensus_aura::SlotDuration::from_millis(SLOT_DURATION)
		}
		fn authorities() -> Vec<AuraId> {
			pallet_aura::Authorities::<Runtime>::get().into_inner()
		}
	}

	impl cumulus_primitives_aura::AuraUnincludedSegmentApi<Block> for Runtime {
		fn can_build_upon(
			included_hash: <Block as sp_runtime::traits::Block>::Hash,
			slot: cumulus_primitives_aura::Slot,
		) -> bool {
			ConsensusHook::can_build_upon(included_hash, slot)
		}
	}

	impl sp_api::Core<Block> for Runtime {
		fn version() -> sp_version::RuntimeVersion { VERSION }
		fn execute_block(block: <Block as sp_runtime::traits::Block>::LazyBlock) {
			Executive::execute_block(block)
		}
		fn initialize_block(header: &<Block as sp_runtime::traits::Block>::Header) -> sp_runtime::ExtrinsicInclusionMode {
			Executive::initialize_block(header)
		}
	}

	impl sp_api::Metadata<Block> for Runtime {
		fn metadata() -> sp_core::OpaqueMetadata { sp_core::OpaqueMetadata::new(Runtime::metadata().into()) }
		fn metadata_at_version(version: u32) -> Option<sp_core::OpaqueMetadata> { Runtime::metadata_at_version(version) }
		fn metadata_versions() -> Vec<u32> { Runtime::metadata_versions() }
	}

	impl frame_support::view_functions::runtime_api::RuntimeViewFunction<Block> for Runtime {
		fn execute_view_function(id: frame_support::view_functions::ViewFunctionId, input: Vec<u8>) -> Result<Vec<u8>, frame_support::view_functions::ViewFunctionDispatchError> {
			Runtime::execute_view_function(id, input)
		}
	}

	impl sp_block_builder::BlockBuilder<Block> for Runtime {
		fn apply_extrinsic(extrinsic: <Block as sp_runtime::traits::Block>::Extrinsic) -> sp_runtime::ApplyExtrinsicResult {
			Executive::apply_extrinsic(extrinsic)
		}
		fn finalize_block() -> <Block as sp_runtime::traits::Block>::Header { Executive::finalize_block() }
		fn inherent_extrinsics(data: sp_inherents::InherentData) -> Vec<<Block as sp_runtime::traits::Block>::Extrinsic> {
			data.create_extrinsics()
		}
		fn check_inherents(block: <Block as sp_runtime::traits::Block>::LazyBlock, data: sp_inherents::InherentData) -> sp_inherents::CheckInherentsResult {
			data.check_extrinsics(&block)
		}
	}

	impl sp_transaction_pool::runtime_api::TaggedTransactionQueue<Block> for Runtime {
		fn validate_transaction(source: sp_runtime::transaction_validity::TransactionSource, tx: <Block as sp_runtime::traits::Block>::Extrinsic, block_hash: <Block as sp_runtime::traits::Block>::Hash) -> sp_runtime::transaction_validity::TransactionValidity {
			Executive::validate_transaction(source, tx, block_hash)
		}
	}

	impl sp_offchain::OffchainWorkerApi<Block> for Runtime {
		fn offchain_worker(header: &<Block as sp_runtime::traits::Block>::Header) { Executive::offchain_worker(header) }
	}

	impl sp_session::SessionKeys<Block> for Runtime {
		fn generate_session_keys(owner: Vec<u8>, seed: Option<Vec<u8>>) -> sp_session::OpaqueGeneratedSessionKeys {
			SessionKeys::generate(&owner, seed).into()
		}
		fn decode_session_keys(encoded: Vec<u8>) -> Option<Vec<(Vec<u8>, sp_core::crypto::KeyTypeId)>> {
			SessionKeys::decode_into_raw_public_keys(&encoded)
		}
	}

	impl frame_system_rpc_runtime_api::AccountNonceApi<Block, AccountId, Nonce> for Runtime {
		fn account_nonce(account: AccountId) -> Nonce { System::account_nonce(account) }
	}

	impl pallet_transaction_payment_rpc_runtime_api::TransactionPaymentApi<Block, Balance> for Runtime {
		fn query_info(uxt: <Block as sp_runtime::traits::Block>::Extrinsic, len: u32) -> pallet_transaction_payment_rpc_runtime_api::RuntimeDispatchInfo<Balance> { TransactionPayment::query_info(uxt, len) }
		fn query_fee_details(uxt: <Block as sp_runtime::traits::Block>::Extrinsic, len: u32) -> pallet_transaction_payment::FeeDetails<Balance> { TransactionPayment::query_fee_details(uxt, len) }
		fn query_weight_to_fee(weight: frame_support::weights::Weight) -> Balance { TransactionPayment::weight_to_fee(weight) }
		fn query_length_to_fee(length: u32) -> Balance { TransactionPayment::length_to_fee(length) }
	}

	impl pallet_transaction_payment_rpc_runtime_api::TransactionPaymentCallApi<Block, Balance, RuntimeCall> for Runtime {
		fn query_call_info(call: RuntimeCall, len: u32) -> pallet_transaction_payment::RuntimeDispatchInfo<Balance> { TransactionPayment::query_call_info(call, len) }
		fn query_call_fee_details(call: RuntimeCall, len: u32) -> pallet_transaction_payment::FeeDetails<Balance> { TransactionPayment::query_call_fee_details(call, len) }
		fn query_weight_to_fee(weight: frame_support::weights::Weight) -> Balance { TransactionPayment::weight_to_fee(weight) }
		fn query_length_to_fee(length: u32) -> Balance { TransactionPayment::length_to_fee(length) }
	}

	impl cumulus_primitives_core::CollectCollationInfo<Block> for Runtime {
		fn collect_collation_info(header: &<Block as sp_runtime::traits::Block>::Header) -> cumulus_primitives_core::CollationInfo {
			ParachainSystem::collect_collation_info(header)
		}
	}


	#[cfg(feature = "try-runtime")]
	impl frame_try_runtime::TryRuntime<Block> for Runtime {
		fn on_runtime_upgrade(checks: frame_try_runtime::UpgradeCheckSelect) -> (frame_support::weights::Weight, frame_support::weights::Weight) {
			use configs::RuntimeBlockWeights;
			let weight = Executive::try_runtime_upgrade(checks).unwrap();
			(weight, RuntimeBlockWeights::get().max_block)
		}
		fn execute_block(block: Block, state_root_check: bool, signature_check: bool, select: frame_try_runtime::TryStateSelect) -> frame_support::weights::Weight {
			Executive::try_execute_block(block, state_root_check, signature_check, select).unwrap()
		}
	}

	#[cfg(feature = "runtime-benchmarks")]
	impl frame_benchmarking::Benchmark<Block> for Runtime {
		fn benchmark_metadata(extra: bool) -> (Vec<frame_benchmarking::BenchmarkList>, Vec<frame_support::traits::StorageInfo>) {
			use frame_benchmarking::BenchmarkList;
			use frame_support::traits::StorageInfoTrait;
			use frame_system_benchmarking::Pallet as SystemBench;
			use cumulus_pallet_session_benchmarking::Pallet as SessionBench;
			let mut list = Vec::<BenchmarkList>::new();
			list_benchmarks!(list, extra);
			let storage_info = AllPalletsWithSystem::storage_info();
			(list, storage_info)
		}
		#[allow(non_local_definitions)]
		fn dispatch_benchmark(config: frame_benchmarking::BenchmarkConfig) -> Result<Vec<frame_benchmarking::BenchmarkBatch>, alloc::string::String> {
			use frame_benchmarking::{BenchmarkError, BenchmarkBatch};
			use frame_system_benchmarking::Pallet as SystemBench;
			impl frame_system_benchmarking::Config for Runtime {
				fn setup_set_code_requirements(code: &Vec<u8>) -> Result<(), BenchmarkError> {
					ParachainSystem::initialize_for_set_code_benchmark(code.len() as u32);
					Ok(())
				}
				fn verify_set_code() {
					System::assert_last_event(cumulus_pallet_parachain_system::Event::<Runtime>::ValidationFunctionStored.into());
				}
			}
			use cumulus_pallet_session_benchmarking::Pallet as SessionBench;
			impl cumulus_pallet_session_benchmarking::Config for Runtime {}
			use frame_support::traits::WhitelistedStorageKeys;
			let whitelist = AllPalletsWithSystem::whitelisted_storage_keys();
			let mut batches = Vec::<BenchmarkBatch>::new();
			let params = (&config, &whitelist);
			add_benchmarks!(params, batches);
			if batches.is_empty() { return Err("Benchmark not found for this pallet.".into()) }
			Ok(batches)
		}
	}

	impl sp_genesis_builder::GenesisBuilder<Block> for Runtime {
		fn build_state(config: Vec<u8>) -> sp_genesis_builder::Result {
			frame_support::genesis_builder_helper::build_state::<RuntimeGenesisConfig>(config)
		}
		fn get_preset(id: &Option<sp_genesis_builder::PresetId>) -> Option<Vec<u8>> {
			frame_support::genesis_builder_helper::get_preset::<RuntimeGenesisConfig>(id, genesis_config_presets::get_preset)
		}
		fn preset_names() -> Vec<sp_genesis_builder::PresetId> {
			genesis_config_presets::preset_names()
		}
	}
);

#[sp_version::runtime_version]
pub const VERSION: RuntimeVersion = RuntimeVersion {
	spec_name: alloc::borrow::Cow::Borrowed("stack-template-runtime"),
	impl_name: alloc::borrow::Cow::Borrowed("stack-template-runtime"),
	authoring_version: 1,
	spec_version: 3,
	impl_version: 0,
	apis: RUNTIME_API_VERSIONS,
	transaction_version: 2,
	system_version: 1,
};

cumulus_pallet_parachain_system::register_validate_block! {
	Runtime = Runtime,
	BlockExecutor = cumulus_pallet_aura_ext::BlockExecutor::<Runtime, Executive>,
}
