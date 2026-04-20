// Vendored from polkadot-sdk PR #11590 and #11690.
// Original: substrate/frame/asset-conversion/precompiles/src/lib.rs
//
// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

//! Precompile exposing `pallet-asset-conversion` (Asset Hub DEX) to Solidity contracts.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;
use codec::Decode;
use core::marker::PhantomData;
use polkadot_sdk::*;

use frame_support::traits::Get;
use pallet_asset_conversion::{
	weights::WeightInfo as _, AddLiquidityAsset, MutateLiquidity, QuotePrice, Swap,
};
use pallet_revive::precompiles::{
	alloy::{
		self,
		sol_types::{Revert, SolCall},
	},
	AddressMatcher, Error, Ext, Precompile, H160,
};

alloy::sol! {
	/// Precompile interface for asset-conversion (DEX) operations.
	///
	/// Assets are identified by their SCALE-encoded AssetKind (e.g. xcm::v5::Location)
	/// passed as `bytes`. Contracts can hardcode these as constants or obtain them
	/// off-chain.
	interface IAssetConversion {
		/// Swap an exact amount of input tokens for as many output tokens as possible.
		function swapExactTokensForTokens(
			bytes[] calldata path,
			uint256 amountIn,
			uint256 amountOutMin,
			address sendTo,
			bool keepAlive
		) external returns (uint256 amountOut);

		/// Swap tokens to receive an exact amount of output tokens.
		function swapTokensForExactTokens(
			bytes[] calldata path,
			uint256 amountOut,
			uint256 amountInMax,
			address sendTo,
			bool keepAlive
		) external returns (uint256 amountIn);

		/// Quote the expected output for a given exact input swap.
		function quoteExactTokensForTokens(
			bytes calldata asset1,
			bytes calldata asset2,
			uint256 amount,
			bool includeFee
		) external view returns (uint256);

		/// Quote the required input for a given exact output swap.
		function quoteTokensForExactTokens(
			bytes calldata asset1,
			bytes calldata asset2,
			uint256 amount,
			bool includeFee
		) external view returns (uint256);

		/// Create an empty liquidity pool for the given asset pair.
		function createPool(
			bytes calldata asset1,
			bytes calldata asset2
		) external;

		/// Add liquidity to an existing pool.
		function addLiquidity(
			bytes calldata asset1,
			bytes calldata asset2,
			uint256 amount1Desired,
			uint256 amount2Desired,
			uint256 amount1Min,
			uint256 amount2Min,
			address mintTo
		) external returns (uint256 lpTokensMinted);

		/// Remove liquidity from a pool.
		function removeLiquidity(
			bytes calldata asset1,
			bytes calldata asset2,
			uint256 lpTokenBurn,
			uint256 amount1MinReceive,
			uint256 amount2MinReceive,
			address withdrawTo
		) external returns (uint256 amount1, uint256 amount2);

		/// Get the reserves (token balances) of a liquidity pool.
		function getReserves(
			bytes calldata asset1,
			bytes calldata asset2
		) external view returns (uint256 reserve1, uint256 reserve2);
	}
}

/// Asset conversion precompile exposing DEX swap, quote, and pool operations.
///
/// `ADDRESS` is the `u16` identifier embedded at bytes [16..18] of the precompile's H160 address.
pub struct AssetConversion<const ADDRESS: u16, Runtime> {
	_phantom: PhantomData<Runtime>,
}

impl<const ADDRESS: u16, Runtime> Precompile for AssetConversion<ADDRESS, Runtime>
where
	Runtime: pallet_asset_conversion::Config + pallet_revive::Config,
	alloy::primitives::U256: TryInto<<Runtime as pallet_asset_conversion::Config>::Balance>,
	alloy::primitives::U256: TryFrom<<Runtime as pallet_asset_conversion::Config>::Balance>,
{
	type T = Runtime;
	type Interface = IAssetConversion::IAssetConversionCalls;
	const MATCHER: AddressMatcher =
		AddressMatcher::Fixed(core::num::NonZero::new(ADDRESS).unwrap());
	const HAS_CONTRACT_INFO: bool = false;

	fn call(
		_address: &[u8; 20],
		input: &Self::Interface,
		env: &mut impl Ext<T = Self::T>,
	) -> Result<Vec<u8>, Error> {
		use IAssetConversion::IAssetConversionCalls;

		frame_support::ensure!(
			!env.is_delegate_call(),
			pallet_revive::Error::<Self::T>::PrecompileDelegateDenied,
		);

		match input {
			IAssetConversionCalls::swapExactTokensForTokens(_) |
			IAssetConversionCalls::swapTokensForExactTokens(_) |
			IAssetConversionCalls::createPool(_) |
			IAssetConversionCalls::addLiquidity(_) |
			IAssetConversionCalls::removeLiquidity(_)
				if env.is_read_only() =>
			{
				Err(Error::Error(pallet_revive::Error::<Self::T>::StateChangeDenied.into()))
			},
			IAssetConversionCalls::swapExactTokensForTokens(call) => {
				Self::swap_exact_tokens_for_tokens(call, env)
			},
			IAssetConversionCalls::swapTokensForExactTokens(call) => {
				Self::swap_tokens_for_exact_tokens(call, env)
			},
			IAssetConversionCalls::quoteExactTokensForTokens(call) => {
				Self::quote_exact_tokens_for_tokens(call, env)
			},
			IAssetConversionCalls::quoteTokensForExactTokens(call) => {
				Self::quote_tokens_for_exact_tokens(call, env)
			},
			IAssetConversionCalls::createPool(call) => Self::create_pool(call, env),
			IAssetConversionCalls::addLiquidity(call) => Self::add_liquidity(call, env),
			IAssetConversionCalls::removeLiquidity(call) => Self::remove_liquidity(call, env),
			IAssetConversionCalls::getReserves(call) => Self::get_reserves(call, env),
		}
	}
}

const ERR_INVALID_CALLER: &str = "Invalid caller";
const ERR_BALANCE_CONVERSION_FAILED: &str = "Balance conversion failed";
const ERR_POOL_NOT_FOUND: &str = "Pool does not exist or has no liquidity";
const ERR_PATH_TOO_LONG: &str = "Swap path exceeds MaxSwapPathLength";
const ERR_INVALID_ASSET_ENCODING: &str = "Failed to SCALE-decode asset kind";

impl<const ADDRESS: u16, Runtime> AssetConversion<ADDRESS, Runtime>
where
	Runtime: pallet_asset_conversion::Config + pallet_revive::Config,
	alloy::primitives::U256: TryInto<<Runtime as pallet_asset_conversion::Config>::Balance>,
	alloy::primitives::U256: TryFrom<<Runtime as pallet_asset_conversion::Config>::Balance>,
{
	fn caller_account_id(
		env: &impl Ext<T = Runtime>,
	) -> Result<<Runtime as frame_system::Config>::AccountId, Error> {
		env.caller()
			.account_id()
			.map_err(|_| Error::Revert(Revert { reason: ERR_INVALID_CALLER.into() }))
			.cloned()
	}

	fn decode_asset_kind(
		data: &[u8],
	) -> Result<<Runtime as pallet_asset_conversion::Config>::AssetKind, Error> {
		<Runtime as pallet_asset_conversion::Config>::AssetKind::decode(&mut &data[..])
			.map_err(|_| Error::Revert(Revert { reason: ERR_INVALID_ASSET_ENCODING.into() }))
	}

	fn validated_path_len<T>(path: &[T]) -> Result<u32, Error> {
		let len = path.len() as u32;
		let max = <Runtime as pallet_asset_conversion::Config>::MaxSwapPathLength::get();
		if len > max {
			return Err(Error::Revert(Revert { reason: ERR_PATH_TOO_LONG.into() }));
		}
		Ok(len)
	}

	fn to_balance(
		value: alloy::primitives::U256,
	) -> Result<<Runtime as pallet_asset_conversion::Config>::Balance, Error> {
		value
			.try_into()
			.map_err(|_| Error::Revert(Revert { reason: ERR_BALANCE_CONVERSION_FAILED.into() }))
	}

	fn to_u256(
		value: <Runtime as pallet_asset_conversion::Config>::Balance,
	) -> Result<alloy::primitives::U256, Error> {
		alloy::primitives::U256::try_from(value)
			.map_err(|_| Error::Revert(Revert { reason: ERR_BALANCE_CONVERSION_FAILED.into() }))
	}

	fn swap_exact_tokens_for_tokens(
		call: &IAssetConversion::swapExactTokensForTokensCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		let path_len = Self::validated_path_len(&call.path)?;
		env.charge(
			<Runtime as pallet_asset_conversion::Config>::WeightInfo::swap_exact_tokens_for_tokens(
				path_len,
			),
		)?;
		let path: Vec<_> =
			call.path.iter().map(|e| Self::decode_asset_kind(e)).collect::<Result<_, _>>()?;

		let sender = Self::caller_account_id(env)?;
		let send_to = env.to_account_id(&H160(call.sendTo.0 .0));

		let amount_out = <pallet_asset_conversion::Pallet<Runtime> as Swap<
			<Runtime as frame_system::Config>::AccountId,
		>>::swap_exact_tokens_for_tokens(
			sender,
			path,
			Self::to_balance(call.amountIn)?,
			Some(Self::to_balance(call.amountOutMin)?),
			send_to,
			call.keepAlive,
		)?;

		Ok(IAssetConversion::swapExactTokensForTokensCall::abi_encode_returns(&Self::to_u256(
			amount_out,
		)?))
	}

	fn swap_tokens_for_exact_tokens(
		call: &IAssetConversion::swapTokensForExactTokensCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		let path_len = Self::validated_path_len(&call.path)?;
		env.charge(
			<Runtime as pallet_asset_conversion::Config>::WeightInfo::swap_tokens_for_exact_tokens(
				path_len,
			),
		)?;
		let path: Vec<_> =
			call.path.iter().map(|e| Self::decode_asset_kind(e)).collect::<Result<_, _>>()?;

		let sender = Self::caller_account_id(env)?;
		let send_to = env.to_account_id(&H160(call.sendTo.0 .0));

		let amount_in = <pallet_asset_conversion::Pallet<Runtime> as Swap<
			<Runtime as frame_system::Config>::AccountId,
		>>::swap_tokens_for_exact_tokens(
			sender,
			path,
			Self::to_balance(call.amountOut)?,
			Some(Self::to_balance(call.amountInMax)?),
			send_to,
			call.keepAlive,
		)?;

		Ok(IAssetConversion::swapTokensForExactTokensCall::abi_encode_returns(&Self::to_u256(
			amount_in,
		)?))
	}

	fn quote_exact_tokens_for_tokens(
		call: &IAssetConversion::quoteExactTokensForTokensCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(
			<Runtime as pallet_asset_conversion::Config>::WeightInfo::swap_exact_tokens_for_tokens(
				2,
			),
		)?;

		let asset1 = Self::decode_asset_kind(&call.asset1)?;
		let asset2 = Self::decode_asset_kind(&call.asset2)?;

		let quoted =
			<pallet_asset_conversion::Pallet<Runtime> as QuotePrice>::quote_price_exact_tokens_for_tokens(
				asset1,
				asset2,
				Self::to_balance(call.amount)?,
				call.includeFee,
			)
			.ok_or(Error::Revert(Revert { reason: ERR_POOL_NOT_FOUND.into() }))?;

		Ok(IAssetConversion::quoteExactTokensForTokensCall::abi_encode_returns(&Self::to_u256(
			quoted,
		)?))
	}

	fn quote_tokens_for_exact_tokens(
		call: &IAssetConversion::quoteTokensForExactTokensCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(
			<Runtime as pallet_asset_conversion::Config>::WeightInfo::swap_tokens_for_exact_tokens(
				2,
			),
		)?;

		let asset1 = Self::decode_asset_kind(&call.asset1)?;
		let asset2 = Self::decode_asset_kind(&call.asset2)?;

		let quoted =
			<pallet_asset_conversion::Pallet<Runtime> as QuotePrice>::quote_price_tokens_for_exact_tokens(
				asset1,
				asset2,
				Self::to_balance(call.amount)?,
				call.includeFee,
			)
			.ok_or(Error::Revert(Revert { reason: ERR_POOL_NOT_FOUND.into() }))?;

		Ok(IAssetConversion::quoteTokensForExactTokensCall::abi_encode_returns(&Self::to_u256(
			quoted,
		)?))
	}

	fn create_pool(
		call: &IAssetConversion::createPoolCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(<Runtime as pallet_asset_conversion::Config>::WeightInfo::create_pool())?;

		let asset1 = Self::decode_asset_kind(&call.asset1)?;
		let asset2 = Self::decode_asset_kind(&call.asset2)?;

		let sender = Self::caller_account_id(env)?;

		<pallet_asset_conversion::Pallet<Runtime> as MutateLiquidity<
			<Runtime as frame_system::Config>::AccountId,
		>>::create_pool(&sender, asset1, asset2)?;

		Ok(Vec::new())
	}

	fn add_liquidity(
		call: &IAssetConversion::addLiquidityCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(<Runtime as pallet_asset_conversion::Config>::WeightInfo::add_liquidity())?;

		let asset1 = Self::decode_asset_kind(&call.asset1)?;
		let asset2 = Self::decode_asset_kind(&call.asset2)?;

		let sender = Self::caller_account_id(env)?;
		let mint_to = env.to_account_id(&H160(call.mintTo.0 .0));

		let lp_tokens = <pallet_asset_conversion::Pallet<Runtime> as MutateLiquidity<
			<Runtime as frame_system::Config>::AccountId,
		>>::add_liquidity(
			&sender,
			AddLiquidityAsset {
				asset: asset1,
				amount_desired: Self::to_balance(call.amount1Desired)?,
				amount_min: Self::to_balance(call.amount1Min)?,
			},
			AddLiquidityAsset {
				asset: asset2,
				amount_desired: Self::to_balance(call.amount2Desired)?,
				amount_min: Self::to_balance(call.amount2Min)?,
			},
			&mint_to,
		)?;

		Ok(IAssetConversion::addLiquidityCall::abi_encode_returns(&Self::to_u256(lp_tokens)?))
	}

	fn remove_liquidity(
		call: &IAssetConversion::removeLiquidityCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		env.charge(<Runtime as pallet_asset_conversion::Config>::WeightInfo::remove_liquidity())?;

		let asset1 = Self::decode_asset_kind(&call.asset1)?;
		let asset2 = Self::decode_asset_kind(&call.asset2)?;

		let sender = Self::caller_account_id(env)?;
		let withdraw_to = env.to_account_id(&H160(call.withdrawTo.0 .0));

		let (amount1, amount2) = <pallet_asset_conversion::Pallet<Runtime> as MutateLiquidity<
			<Runtime as frame_system::Config>::AccountId,
		>>::remove_liquidity(
			&sender,
			asset1,
			asset2,
			Self::to_balance(call.lpTokenBurn)?,
			Self::to_balance(call.amount1MinReceive)?,
			Self::to_balance(call.amount2MinReceive)?,
			&withdraw_to,
		)?;

		Ok(IAssetConversion::removeLiquidityCall::abi_encode_returns(
			&IAssetConversion::removeLiquidityReturn {
				amount1: Self::to_u256(amount1)?,
				amount2: Self::to_u256(amount2)?,
			},
		))
	}

	fn get_reserves(
		call: &IAssetConversion::getReservesCall,
		env: &mut impl Ext<T = Runtime>,
	) -> Result<Vec<u8>, Error> {
		// Same weight rationale as quote functions: charge swap weight for path length 2.
		env.charge(
			<Runtime as pallet_asset_conversion::Config>::WeightInfo::swap_exact_tokens_for_tokens(
				2,
			),
		)?;

		let asset1 = Self::decode_asset_kind(&call.asset1)?;
		let asset2 = Self::decode_asset_kind(&call.asset2)?;

		let (reserve1, reserve2) =
			pallet_asset_conversion::Pallet::<Runtime>::get_reserves(asset1, asset2)
				.map_err(|_| Error::Revert(Revert { reason: ERR_POOL_NOT_FOUND.into() }))?;

		Ok(IAssetConversion::getReservesCall::abi_encode_returns(
			&IAssetConversion::getReservesReturn {
				reserve1: Self::to_u256(reserve1)?,
				reserve2: Self::to_u256(reserve2)?,
			},
		))
	}
}
