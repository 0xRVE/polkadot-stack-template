// Vendored from pallet-assets-precompiles v0.4.1 (polkadot-sdk stable2512-3).
// Changes:
//   - Added is_delegate_call() guard on state-changing operations (CVE mitigation)
//   - Added wildcard arm for newer IERC20 methods (name, symbol, decimals, permit)
//   - Uses polkadot-sdk umbrella crate instead of individual crate dependencies

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;
use core::marker::PhantomData;
use polkadot_sdk::*;

use pallet_assets::{weights::WeightInfo, Call, Config, TransferFlags};
use pallet_revive::precompiles::{
	alloy::{
		self,
		primitives::IntoLogData,
		sol_types::{Revert, SolCall},
	},
	AddressMapper, AddressMatcher, Error, Ext, Precompile, RuntimeCosts, H160, H256,
};

// Define the IERC20 interface inline to avoid ethereum-standards version conflicts.
alloy::sol! {
	interface IERC20 {
		function totalSupply() external view returns (uint256);
		function balanceOf(address account) external view returns (uint256);
		function transfer(address to, uint256 value) external returns (bool);
		function allowance(address owner, address spender) external view returns (uint256);
		function approve(address spender, uint256 value) external returns (bool);
		function transferFrom(address from, address to, uint256 value) external returns (bool);

		event Transfer(address indexed from, address indexed to, uint256 value);
		event Approval(address indexed owner, address indexed spender, uint256 value);
	}
}

use IERC20::{IERC20Calls, IERC20Events};

/// Extracts the asset id from the precompile address.
pub trait AssetIdExtractor {
	type AssetId;
	fn asset_id_from_address(address: &[u8; 20]) -> Result<Self::AssetId, Error>;
}

/// Configuration for a pallet-assets precompile.
pub trait AssetPrecompileConfig {
	const MATCHER: AddressMatcher;
	type AssetIdExtractor: AssetIdExtractor;
}

/// Extracts the asset id from the first 4 bytes of the address (big-endian u32).
pub struct InlineAssetIdExtractor;

impl AssetIdExtractor for InlineAssetIdExtractor {
	type AssetId = u32;
	fn asset_id_from_address(addr: &[u8; 20]) -> Result<Self::AssetId, Error> {
		let bytes: [u8; 4] = addr[0..4].try_into().expect("slice is 4 bytes; qed");
		Ok(u32::from_be_bytes(bytes))
	}
}

/// Precompile configuration using a prefix [`AddressMatcher`].
/// Asset ID is embedded in bytes [0..4], prefix in bytes [16..18].
pub struct InlineIdConfig<const PREFIX: u16>;

impl<const P: u16> AssetPrecompileConfig for InlineIdConfig<P> {
	const MATCHER: AddressMatcher = AddressMatcher::Prefix(core::num::NonZero::new(P).unwrap());
	type AssetIdExtractor = InlineAssetIdExtractor;
}

/// ERC20 precompile for pallet-assets.
pub struct ERC20<Runtime, PrecompileConfig, Instance = ()> {
	_phantom: PhantomData<(Runtime, PrecompileConfig, Instance)>,
}

impl<Runtime, PrecompileConfig, Instance: 'static> Precompile
	for ERC20<Runtime, PrecompileConfig, Instance>
where
	PrecompileConfig: AssetPrecompileConfig,
	Runtime: Config<Instance> + pallet_revive::Config,
	<<PrecompileConfig as AssetPrecompileConfig>::AssetIdExtractor as AssetIdExtractor>::AssetId:
		Into<<Runtime as Config<Instance>>::AssetId>,
	Call<Runtime, Instance>: Into<<Runtime as pallet_revive::Config>::RuntimeCall>,
	alloy::primitives::U256: TryInto<<Runtime as Config<Instance>>::Balance>,
	alloy::primitives::U256: TryFrom<<Runtime as Config<Instance>>::Balance>,
{
	type T = Runtime;
	type Interface = IERC20::IERC20Calls;
	const MATCHER: AddressMatcher = PrecompileConfig::MATCHER;
	const HAS_CONTRACT_INFO: bool = false;

	fn call(
		address: &[u8; 20],
		input: &Self::Interface,
		env: &mut impl Ext<T = Self::T>,
	) -> Result<Vec<u8>, Error> {
		let asset_id = PrecompileConfig::AssetIdExtractor::asset_id_from_address(address)?.into();

		match input {
			// Block state-changing calls in read-only or delegatecall context.
			// Delegatecall guard prevents caller-confusion attacks where a malicious
			// contract could operate as the victim via DELEGATECALL.
			IERC20Calls::transfer(_) | IERC20Calls::approve(_) | IERC20Calls::transferFrom(_)
				if env.is_read_only() =>
			{
				Err(Error::Error(pallet_revive::Error::<Self::T>::StateChangeDenied.into()))
			},
			IERC20Calls::transfer(_) | IERC20Calls::approve(_) | IERC20Calls::transferFrom(_)
				if env.is_delegate_call() =>
			{
				Err(Error::Error(pallet_revive::Error::<Self::T>::PrecompileDelegateDenied.into()))
			},

			IERC20Calls::transfer(call) => Self::transfer(asset_id, call, env),
			IERC20Calls::totalSupply(_) => Self::total_supply(asset_id, env),
			IERC20Calls::balanceOf(call) => Self::balance_of(asset_id, call, env),
			IERC20Calls::allowance(call) => Self::allowance(asset_id, call, env),
			IERC20Calls::approve(call) => Self::approve(asset_id, call, env),
			IERC20Calls::transferFrom(call) => Self::transfer_from(asset_id, call, env),
		}
	}
}

const ERR_INVALID_CALLER: &str = "Invalid caller";
const ERR_BALANCE_CONVERSION_FAILED: &str = "Balance conversion failed";

impl<Runtime, PrecompileConfig, Instance: 'static> ERC20<Runtime, PrecompileConfig, Instance>
where
	PrecompileConfig: AssetPrecompileConfig,
	Runtime: Config<Instance> + pallet_revive::Config,
	<<PrecompileConfig as AssetPrecompileConfig>::AssetIdExtractor as AssetIdExtractor>::AssetId:
		Into<<Runtime as Config<Instance>>::AssetId>,
	Call<Runtime, Instance>: Into<<Runtime as pallet_revive::Config>::RuntimeCall>,
	alloy::primitives::U256: TryInto<<Runtime as Config<Instance>>::Balance>,
	alloy::primitives::U256: TryFrom<<Runtime as Config<Instance>>::Balance>,
{
	fn caller(env: &mut impl Ext<T = Runtime>) -> Result<H160, Error> {
		env.caller()
			.account_id()
			.map(<Runtime as pallet_revive::Config>::AddressMapper::to_address)
			.map_err(|_| Error::Revert(Revert { reason: ERR_INVALID_CALLER.into() }))
	}

	fn to_balance(
		value: alloy::primitives::U256,
	) -> Result<<Runtime as Config<Instance>>::Balance, Error> {
		value
			.try_into()
			.map_err(|_| Error::Revert(Revert { reason: ERR_BALANCE_CONVERSION_FAILED.into() }))
	}

	fn to_u256(
		value: <Runtime as Config<Instance>>::Balance,
	) -> Result<alloy::primitives::U256, Error> {
		alloy::primitives::U256::try_from(value)
			.map_err(|_| Error::Revert(Revert { reason: ERR_BALANCE_CONVERSION_FAILED.into() }))
	}

	fn deposit_event(env: &mut impl Ext<T = Runtime>, event: IERC20Events) -> Result<(), Error> {
		let (topics, data) = event.into_log_data().split();
		let topics = topics.into_iter().map(|v| H256(v.0)).collect::<Vec<_>>();
		env.frame_meter_mut().charge_weight_token(RuntimeCosts::DepositEvent {
			num_topic: topics.len() as u32,
			len: topics.len() as u32,
		})?;
		env.deposit_event(topics, data.to_vec());
		Ok(())
	}

	fn transfer(
		asset_id: <Runtime as Config<Instance>>::AssetId,
		call: &IERC20::transferCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(<Runtime as Config<Instance>>::WeightInfo::transfer())?;

		let from = Self::caller(env)?;
		let dest = <Runtime as pallet_revive::Config>::AddressMapper::to_account_id(
			&call.to.into_array().into(),
		);

		let f = TransferFlags { keep_alive: false, best_effort: false, burn_dust: false };
		pallet_assets::Pallet::<Runtime, Instance>::do_transfer(
			asset_id,
			&<Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&from),
			&dest,
			Self::to_balance(call.value)?,
			None,
			f,
		)?;

		Self::deposit_event(
			env,
			IERC20Events::Transfer(IERC20::Transfer {
				from: from.0.into(),
				to: call.to,
				value: call.value,
			}),
		)?;

		Ok(IERC20::transferCall::abi_encode_returns(&true))
	}

	fn total_supply(
		asset_id: <Runtime as Config<Instance>>::AssetId,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		use frame_support::traits::fungibles::Inspect;
		env.charge(<Runtime as Config<Instance>>::WeightInfo::total_issuance())?;

		let value =
			Self::to_u256(pallet_assets::Pallet::<Runtime, Instance>::total_issuance(asset_id))?;
		Ok(IERC20::totalSupplyCall::abi_encode_returns(&value))
	}

	fn balance_of(
		asset_id: <Runtime as Config<Instance>>::AssetId,
		call: &IERC20::balanceOfCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(<Runtime as Config<Instance>>::WeightInfo::balance())?;
		let account = call.account.into_array().into();
		let account = <Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&account);
		let value =
			Self::to_u256(pallet_assets::Pallet::<Runtime, Instance>::balance(asset_id, account))?;
		Ok(IERC20::balanceOfCall::abi_encode_returns(&value))
	}

	fn allowance(
		asset_id: <Runtime as Config<Instance>>::AssetId,
		call: &IERC20::allowanceCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(<Runtime as Config<Instance>>::WeightInfo::allowance())?;
		use frame_support::traits::fungibles::approvals::Inspect;
		let owner = call.owner.into_array().into();
		let owner = <Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&owner);

		let spender = call.spender.into_array().into();
		let spender = <Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&spender);
		let value = Self::to_u256(pallet_assets::Pallet::<Runtime, Instance>::allowance(
			asset_id, &owner, &spender,
		))?;

		Ok(IERC20::allowanceCall::abi_encode_returns(&value))
	}

	fn approve(
		asset_id: <Runtime as Config<Instance>>::AssetId,
		call: &IERC20::approveCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(<Runtime as Config<Instance>>::WeightInfo::approve_transfer())?;
		let owner = Self::caller(env)?;
		let spender = call.spender.into_array().into();
		let spender = <Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&spender);

		pallet_assets::Pallet::<Runtime, Instance>::do_approve_transfer(
			asset_id,
			&<Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&owner),
			&spender,
			Self::to_balance(call.value)?,
		)?;

		Self::deposit_event(
			env,
			IERC20Events::Approval(IERC20::Approval {
				owner: owner.0.into(),
				spender: call.spender,
				value: call.value,
			}),
		)?;

		Ok(IERC20::approveCall::abi_encode_returns(&true))
	}

	fn transfer_from(
		asset_id: <Runtime as Config<Instance>>::AssetId,
		call: &IERC20::transferFromCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(<Runtime as Config<Instance>>::WeightInfo::transfer_approved())?;
		let spender = Self::caller(env)?;
		let spender = <Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&spender);

		let from = call.from.into_array().into();
		let from = <Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&from);

		let to = call.to.into_array().into();
		let to = <Runtime as pallet_revive::Config>::AddressMapper::to_account_id(&to);

		pallet_assets::Pallet::<Runtime, Instance>::do_transfer_approved(
			asset_id,
			&from,
			&spender,
			&to,
			Self::to_balance(call.value)?,
		)?;

		Self::deposit_event(
			env,
			IERC20Events::Transfer(IERC20::Transfer {
				from: call.from,
				to: call.to,
				value: call.value,
			}),
		)?;

		Ok(IERC20::transferFromCall::abi_encode_returns(&true))
	}
}
