mod xcm_config;

use polkadot_sdk::{staging_xcm as xcm, *};

use cumulus_pallet_parachain_system::RelayNumberMonotonicallyIncreases;
use cumulus_primitives_core::{AggregateMessageOrigin, ParaId};
use frame_support::{
	derive_impl,
	dispatch::DispatchClass,
	parameter_types,
	traits::{
		ConstBool, ConstU128, ConstU32, ConstU64, ConstU8, EitherOfDiverse, TransformOrigin,
		VariantCountOf,
	},
	weights::{ConstantMultiplier, Weight},
	PalletId,
};
use frame_system::{
	limits::{BlockLength, BlockWeights},
	EnsureRoot, EnsureSigned,
};
use pallet_xcm::{EnsureXcm, IsVoiceOfBody};
use parachains_common::message_queue::{NarrowOriginToSibling, ParaIdToSibling};
use polkadot_runtime_common::{
	xcm_sender::NoPriceForMessageDelivery, BlockHashCount, SlowAdjustingFeeUpdate,
};
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_runtime::{Perbill, Permill};
use sp_version::RuntimeVersion;
use xcm::latest::prelude::BodyId;

use super::{
	weights::{BlockExecutionWeight, ExtrinsicBaseWeight, RocksDbWeight},
	AccountId, Assets, Aura, Balance, Balances, Block, BlockNumber, CollatorSelection, PoolAssets,
	ConsensusHook, Hash, MessageQueue, Nonce, PalletInfo, ParachainSystem, Runtime, RuntimeCall,
	RuntimeEvent, RuntimeFreezeReason, RuntimeHoldReason, RuntimeOrigin, RuntimeTask, Session,
	SessionKeys, System, Timestamp, XcmpQueue, AVERAGE_ON_INITIALIZE_RATIO, EXISTENTIAL_DEPOSIT,
	HOURS, MAXIMUM_BLOCK_WEIGHT, MICRO_UNIT, NORMAL_DISPATCH_RATIO, SLOT_DURATION, VERSION,
};
use xcm_config::{RelayLocation, XcmOriginToTransactDispatchOrigin};

parameter_types! {
	pub const Version: RuntimeVersion = VERSION;
	pub RuntimeBlockLength: BlockLength =
		BlockLength::builder()
			.max_length(5 * 1024 * 1024)
			.modify_max_length_for_class(DispatchClass::Normal, |max| {
				*max = NORMAL_DISPATCH_RATIO * *max;
			})
			.build();
	pub RuntimeBlockWeights: BlockWeights = BlockWeights::builder()
		.base_block(BlockExecutionWeight::get())
		.for_class(DispatchClass::all(), |weights| {
			weights.base_extrinsic = ExtrinsicBaseWeight::get();
		})
		.for_class(DispatchClass::Normal, |weights| {
			weights.max_total = Some(NORMAL_DISPATCH_RATIO * MAXIMUM_BLOCK_WEIGHT);
		})
		.for_class(DispatchClass::Operational, |weights| {
			weights.max_total = Some(MAXIMUM_BLOCK_WEIGHT);
			weights.reserved = Some(
				MAXIMUM_BLOCK_WEIGHT - NORMAL_DISPATCH_RATIO * MAXIMUM_BLOCK_WEIGHT
			);
		})
		.avg_block_initialization(AVERAGE_ON_INITIALIZE_RATIO)
		.build_or_panic();
	pub const SS58Prefix: u16 = 42;
}

#[derive_impl(frame_system::config_preludes::ParaChainDefaultConfig)]
impl frame_system::Config for Runtime {
	type AccountId = AccountId;
	type Nonce = Nonce;
	type Hash = Hash;
	type Block = Block;
	type BlockHashCount = BlockHashCount;
	type Version = Version;
	type AccountData = pallet_balances::AccountData<Balance>;
	type DbWeight = RocksDbWeight;
	type BlockWeights = RuntimeBlockWeights;
	type BlockLength = RuntimeBlockLength;
	type SS58Prefix = SS58Prefix;
	type OnSetCode = cumulus_pallet_parachain_system::ParachainSetCode<Self>;
	type MaxConsumers = frame_support::traits::ConstU32<16>;
}

impl cumulus_pallet_weight_reclaim::Config for Runtime {
	type WeightInfo = ();
}

impl pallet_timestamp::Config for Runtime {
	type Moment = u64;
	type OnTimestampSet = Aura;
	type MinimumPeriod = ConstU64<0>;
	type WeightInfo = ();
}

impl pallet_authorship::Config for Runtime {
	type FindAuthor = pallet_session::FindAccountFromAuthorIndex<Self, Aura>;
	type EventHandler = (CollatorSelection,);
}

parameter_types! {
	pub const ExistentialDeposit: Balance = EXISTENTIAL_DEPOSIT;
}

impl pallet_balances::Config for Runtime {
	type MaxLocks = ConstU32<50>;
	type Balance = Balance;
	type RuntimeEvent = RuntimeEvent;
	type DustRemoval = ();
	type ExistentialDeposit = ExistentialDeposit;
	type AccountStore = System;
	type WeightInfo = pallet_balances::weights::SubstrateWeight<Runtime>;
	type MaxReserves = ConstU32<50>;
	type ReserveIdentifier = [u8; 8];
	type RuntimeHoldReason = RuntimeHoldReason;
	type RuntimeFreezeReason = RuntimeFreezeReason;
	type FreezeIdentifier = RuntimeFreezeReason;
	type MaxFreezes = VariantCountOf<RuntimeFreezeReason>;
	type DoneSlashHandler = ();
}

parameter_types! {
	pub const TransactionByteFee: Balance = 10 * MICRO_UNIT;
}

impl pallet_transaction_payment::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type OnChargeTransaction = pallet_transaction_payment::FungibleAdapter<Balances, ()>;
	type WeightToFee = pallet_revive::evm::fees::BlockRatioFee<
		{ super::MILLI_UNIT / 10 },
		{ (100 * ExtrinsicBaseWeight::get().ref_time()) as u128 },
		Runtime,
		Balance,
	>;
	type LengthToFee = ConstantMultiplier<Balance, TransactionByteFee>;
	type FeeMultiplierUpdate = SlowAdjustingFeeUpdate<Self>;
	type OperationalFeeMultiplier = ConstU8<5>;
	type WeightInfo = ();
}

impl pallet_sudo::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type WeightInfo = ();
}

parameter_types! {
	pub const ReservedXcmpWeight: Weight = MAXIMUM_BLOCK_WEIGHT.saturating_div(4);
	pub const ReservedDmpWeight: Weight = MAXIMUM_BLOCK_WEIGHT.saturating_div(4);
	pub const RelayOrigin: AggregateMessageOrigin = AggregateMessageOrigin::Parent;
}

impl cumulus_pallet_parachain_system::Config for Runtime {
	type WeightInfo = ();
	type RuntimeEvent = RuntimeEvent;
	type OnSystemEvent = ();
	type SelfParaId = staging_parachain_info::Pallet<Runtime>;
	type OutboundXcmpMessageSource = XcmpQueue;
	type DmpQueue = frame_support::traits::EnqueueWithOrigin<MessageQueue, RelayOrigin>;
	type ReservedDmpWeight = ReservedDmpWeight;
	type XcmpMessageHandler = XcmpQueue;
	type ReservedXcmpWeight = ReservedXcmpWeight;
	type CheckAssociatedRelayNumber = RelayNumberMonotonicallyIncreases;
	type ConsensusHook = ConsensusHook;
	type RelayParentOffset = ConstU32<0>;
}

impl staging_parachain_info::Config for Runtime {}

parameter_types! {
	pub MessageQueueServiceWeight: Weight = Perbill::from_percent(35) * RuntimeBlockWeights::get().max_block;
}

impl pallet_message_queue::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type WeightInfo = ();
	#[cfg(feature = "runtime-benchmarks")]
	type MessageProcessor = pallet_message_queue::mock_helpers::NoopMessageProcessor<
		cumulus_primitives_core::AggregateMessageOrigin,
	>;
	#[cfg(not(feature = "runtime-benchmarks"))]
	type MessageProcessor = staging_xcm_builder::ProcessXcmMessage<
		AggregateMessageOrigin,
		staging_xcm_executor::XcmExecutor<xcm_config::XcmConfig>,
		RuntimeCall,
	>;
	type Size = u32;
	type QueueChangeHandler = NarrowOriginToSibling<XcmpQueue>;
	type QueuePausedQuery = NarrowOriginToSibling<XcmpQueue>;
	type HeapSize = sp_core::ConstU32<{ 103 * 1024 }>;
	type MaxStale = sp_core::ConstU32<8>;
	type ServiceWeight = MessageQueueServiceWeight;
	type IdleMaxServiceWeight = ();
}

impl cumulus_pallet_aura_ext::Config for Runtime {}

impl cumulus_pallet_xcmp_queue::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type ChannelInfo = ParachainSystem;
	type VersionWrapper = ();
	type XcmpQueue = TransformOrigin<MessageQueue, AggregateMessageOrigin, ParaId, ParaIdToSibling>;
	type MaxInboundSuspended = sp_core::ConstU32<1_000>;
	type MaxActiveOutboundChannels = ConstU32<128>;
	type MaxPageSize = ConstU32<{ 1 << 16 }>;
	type ControllerOrigin = EnsureRoot<AccountId>;
	type ControllerOriginConverter = XcmOriginToTransactDispatchOrigin;
	type WeightInfo = ();
	type PriceForSiblingDelivery = NoPriceForMessageDelivery<ParaId>;
}

parameter_types! {
	/// Session rotation period — sessions last 6 hours worth of blocks.
	pub const Period: u32 = 6 * HOURS;
	pub const Offset: u32 = 0;
}

impl pallet_session::Config for Runtime {
	type Currency = Balances;
	type KeyDeposit = ();
	type RuntimeEvent = RuntimeEvent;
	type ValidatorId = <Self as frame_system::Config>::AccountId;
	type ValidatorIdOf = pallet_collator_selection::IdentityCollator;
	type ShouldEndSession = pallet_session::PeriodicSessions<Period, Offset>;
	type NextSessionRotation = pallet_session::PeriodicSessions<Period, Offset>;
	type SessionManager = CollatorSelection;
	type SessionHandler = <SessionKeys as sp_runtime::traits::OpaqueKeys>::KeyTypeIdProviders;
	type Keys = SessionKeys;
	type DisablingStrategy = ();
	type WeightInfo = ();
}

impl pallet_aura::Config for Runtime {
	type AuthorityId = AuraId;
	type DisabledValidators = ();
	type MaxAuthorities = ConstU32<100_000>;
	type AllowMultipleBlocksPerSlot = ConstBool<true>;
	type SlotDuration = ConstU64<SLOT_DURATION>;
}

parameter_types! {
	pub const PotId: PalletId = PalletId(*b"PotStake");
	/// Session length for collator-selection kick threshold evaluation.
	pub const SessionLength: BlockNumber = 6 * HOURS;
	pub const StakingAdminBodyId: BodyId = BodyId::Defense;
}

pub type CollatorSelectionUpdateOrigin = EitherOfDiverse<
	EnsureRoot<AccountId>,
	EnsureXcm<IsVoiceOfBody<RelayLocation, StakingAdminBodyId>>,
>;

impl pallet_collator_selection::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Currency = Balances;
	type UpdateOrigin = CollatorSelectionUpdateOrigin;
	type PotId = PotId;
	type MaxCandidates = ConstU32<100>;
	type MinEligibleCollators = ConstU32<4>;
	type MaxInvulnerables = ConstU32<20>;
	type KickThreshold = Period;
	type ValidatorId = <Self as frame_system::Config>::AccountId;
	type ValidatorIdOf = pallet_collator_selection::IdentityCollator;
	type ValidatorRegistration = Session;
	type WeightInfo = ();
}

// Statement Store cost parameters.
// StatementCost: flat fee per statement (10x existential deposit).
// StatementByteCost: per-byte fee (existential deposit / 1024).
// Min/MaxAllowedStatements: per-account statement count limits.
// Min/MaxAllowedBytes: per-account total byte limits (1 MiB to 16 MiB).
parameter_types! {
	pub const StatementCost: Balance = 10 * EXISTENTIAL_DEPOSIT;
	pub const StatementByteCost: Balance = EXISTENTIAL_DEPOSIT / 1024;
	pub const MinAllowedStatements: u32 = 1;
	pub const MaxAllowedStatements: u32 = 16;
	pub const MinAllowedBytes: u32 = 1024 * 1024;
	pub const MaxAllowedBytes: u32 = 16 * 1024 * 1024;
}

impl pallet_statement::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Currency = Balances;
	type StatementCost = StatementCost;
	type ByteCost = StatementByteCost;
	type MinAllowedStatements = MinAllowedStatements;
	type MaxAllowedStatements = MaxAllowedStatements;
	type MinAllowedBytes = MinAllowedBytes;
	type MaxAllowedBytes = MaxAllowedBytes;
}

/// Configure the template proof-of-existence pallet.
impl pallet_template::Config for Runtime {
	type WeightInfo = pallet_template::weights::SubstrateWeight<Runtime>;
}

// ── pallet-assets (fungible tokens for DEX) ───────────────────────────

impl pallet_assets::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Balance = Balance;
	type AssetId = u32;
	type AssetIdParameter = codec::Compact<u32>;
	type Currency = Balances;
	type CreateOrigin = frame_support::traits::AsEnsureOriginWithArg<EnsureSigned<AccountId>>;
	type ForceOrigin = EnsureRoot<AccountId>;
	type AssetDeposit = ConstU128<{ EXISTENTIAL_DEPOSIT }>;
	type AssetAccountDeposit = ConstU128<{ EXISTENTIAL_DEPOSIT }>;
	type MetadataDepositBase = ConstU128<{ EXISTENTIAL_DEPOSIT }>;
	type MetadataDepositPerByte = ConstU128<{ MICRO_UNIT }>;
	type ApprovalDeposit = ConstU128<{ EXISTENTIAL_DEPOSIT }>;
	type StringLimit = ConstU32<50>;
	type Freezer = ();
	type Extra = ();
	type CallbackHandle = ();
	type WeightInfo = pallet_assets::weights::SubstrateWeight<Runtime>;
	type RemoveItemsLimit = ConstU32<1000>;
	type ReserveData = ();
	type Holder = ();
	#[cfg(feature = "runtime-benchmarks")]
	type BenchmarkHelper = ();
}

// ── pallet-assets Instance2 (LP tokens for DEX pools) ────────────────
//
// Separate instance so LP token IDs never collide with user-created assets.
// Only pallet-asset-conversion mints/burns these.

impl pallet_assets::Config<pallet_assets::Instance2> for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Balance = Balance;
	type AssetId = u32;
	type AssetIdParameter = codec::Compact<u32>;
	type Currency = Balances;
	type CreateOrigin = frame_support::traits::AsEnsureOriginWithArg<EnsureSigned<AccountId>>;
	type ForceOrigin = EnsureRoot<AccountId>;
	type AssetDeposit = ConstU128<0>;
	type AssetAccountDeposit = ConstU128<{ EXISTENTIAL_DEPOSIT }>;
	type MetadataDepositBase = ConstU128<0>;
	type MetadataDepositPerByte = ConstU128<0>;
	type ApprovalDeposit = ConstU128<{ EXISTENTIAL_DEPOSIT }>;
	type StringLimit = ConstU32<50>;
	type Freezer = ();
	type Extra = ();
	type CallbackHandle = ();
	type WeightInfo = pallet_assets::weights::SubstrateWeight<Runtime>;
	type RemoveItemsLimit = ConstU32<1000>;
	type ReserveData = ();
	type Holder = ();
	#[cfg(feature = "runtime-benchmarks")]
	type BenchmarkHelper = ();
}

// ── pallet-asset-conversion (DEX) ─────────────────────────────────────

/// Asset type: either the native token or a pallet-assets ID.
pub type NativeOrWithId = frame_support::traits::tokens::fungible::NativeOrWithId<u32>;

parameter_types! {
	pub const AssetConversionPalletId: PalletId = PalletId(*b"py/ascon");
	pub const LiquidityWithdrawalFee: Permill = Permill::from_percent(0);
	pub const MaxSwapPathLength: u32 = 4;
	pub const MintMinLiquidity: Balance = 100;
	pub const PoolSetupFee: Balance = 0;
	pub const LPFee: u32 = 3; // 0.3%
}

/// Adapter to combine native Balances with pallet-assets into a single fungibles API.
pub type NativeAndAssets = frame_support::traits::fungible::UnionOf<
	Balances,
	Assets,
	frame_support::traits::tokens::fungible::NativeFromLeft,
	NativeOrWithId,
	AccountId,
>;

/// Pool locator: ascending order for any pair.
pub type PoolLocator = pallet_asset_conversion::Ascending<
	AccountId,
	NativeOrWithId,
	pallet_asset_conversion::AccountIdConverter<
		AssetConversionPalletId,
		(NativeOrWithId, NativeOrWithId),
	>,
>;

pub struct NativeAssetId;
impl frame_support::traits::Get<NativeOrWithId> for NativeAssetId {
	fn get() -> NativeOrWithId {
		NativeOrWithId::Native
	}
}

impl pallet_asset_conversion::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type Balance = Balance;
	type HigherPrecisionBalance = sp_core::U256;
	type AssetKind = NativeOrWithId;
	type Assets = NativeAndAssets;
	type PoolId = (NativeOrWithId, NativeOrWithId);
	type PoolLocator = PoolLocator;
	type PoolAssetId = u32;
	type PoolAssets = PoolAssets;
	type PoolSetupFee = PoolSetupFee;
	type PoolSetupFeeAsset = NativeAssetId;
	type PoolSetupFeeTarget = ();
	type PalletId = AssetConversionPalletId;
	type LPFee = LPFee;
	type LiquidityWithdrawalFee = LiquidityWithdrawalFee;
	type MaxSwapPathLength = MaxSwapPathLength;
	type MintMinLiquidity = MintMinLiquidity;
	type WeightInfo = pallet_asset_conversion::weights::SubstrateWeight<Runtime>;
	#[cfg(feature = "runtime-benchmarks")]
	type BenchmarkHelper = ();
}

// ── pallet-revive (EVM + PVM smart contracts) ──────────────────────────

parameter_types! {
	pub const DepositPerItem: Balance = EXISTENTIAL_DEPOSIT;
	pub const DepositPerChildTrieItem: Balance = EXISTENTIAL_DEPOSIT / 10;
	pub const DepositPerByte: Balance = EXISTENTIAL_DEPOSIT / 100;
	pub CodeHashLockupDepositPercent: Perbill = Perbill::from_percent(30);
	pub const MaxEthExtrinsicWeight: sp_runtime::FixedU128 = sp_runtime::FixedU128::from_rational(5, 10);
}

impl pallet_revive::Config for Runtime {
	type Time = Timestamp;
	type Balance = Balance;
	type Currency = Balances;
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type RuntimeOrigin = RuntimeOrigin;
	type DepositPerItem = DepositPerItem;
	type DepositPerChildTrieItem = DepositPerChildTrieItem;
	type DepositPerByte = DepositPerByte;
	type WeightInfo = pallet_revive::weights::SubstrateWeight<Self>;
	type Precompiles = (
		pallet_asset_conversion_precompiles::AssetConversion<0x0420, Self>,
		pallet_assets_precompiles::ERC20<Self, pallet_assets_precompiles::InlineIdConfig<0x0120>>,
	);
	type AddressMapper = pallet_revive::AccountId32Mapper<Self>;
	type RuntimeMemory = ConstU32<{ 128 * 1024 * 1024 }>;
	type PVFMemory = ConstU32<{ 512 * 1024 * 1024 }>;
	type UploadOrigin = EnsureSigned<Self::AccountId>;
	type InstantiateOrigin = EnsureSigned<Self::AccountId>;
	type RuntimeHoldReason = RuntimeHoldReason;
	type CodeHashLockupDepositPercent = CodeHashLockupDepositPercent;
	/// EVM chain ID for local dev. The Polkadot Hub TestNet uses 420420417; this local
	/// value avoids collisions. Must match the chain ID expected by eth-rpc and wallets.
	type ChainId = ConstU64<420_420_421>;
	type NativeToEthRatio = ConstU32<1_000_000>;
	type FindAuthor = <Runtime as pallet_authorship::Config>::FindAuthor;
	type AllowEVMBytecode = ConstBool<true>;
	type FeeInfo =
		pallet_revive::evm::fees::Info<super::Address, super::Signature, super::EthExtraImpl>;
	type MaxEthExtrinsicWeight = MaxEthExtrinsicWeight;
	type DebugEnabled = ConstBool<true>;
	type GasScale = ConstU32<50_000>;
	type OnBurn = ();
}
