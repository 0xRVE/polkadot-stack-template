//! # Template Pallet - Proof of Existence
//!
//! A proof of existence pallet that demonstrates core FRAME concepts:
//! - Per-hash storage using `StorageMap`
//! - Dispatchable calls (`create_claim`, `revoke_claim`)
//! - Events and errors
//! - Weight annotations via benchmarks
//! - Mock runtime and unit tests
//!
//! Users submit a 32-byte blake2b-256 hash (e.g. of a file) to create an on-chain
//! claim recording who submitted it and when. Only the claim owner can revoke it.
//!
//! This pallet implements the same "proof of existence" concept as the Solidity smart
//! contract templates, allowing developers to compare the three approaches side-by-side.

#![cfg_attr(not(feature = "std"), no_std)]

pub use pallet::*;

#[cfg(test)]
mod mock;

#[cfg(test)]
mod tests;

pub mod weights;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

#[frame::pallet]
pub mod pallet {
	use crate::weights::WeightInfo;
	use frame::prelude::*;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	/// Configuration trait for this pallet.
	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// A type representing the weights required by the dispatchables of this pallet.
		type WeightInfo: WeightInfo;
	}

	/// A proof-of-existence claim: who created it and when.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	#[scale_info(skip_type_params(T))]
	pub struct Claim<T: Config> {
		/// The account that created the claim.
		pub owner: T::AccountId,
		/// The block number when the claim was created.
		pub block_number: BlockNumberFor<T>,
	}

	/// Storage for proof-of-existence claims.
	/// Maps a 32-byte hash to the claim details (owner, block number).
	#[pallet::storage]
	pub type Claims<T: Config> = StorageMap<_, Blake2_128Concat, H256, Claim<T>, OptionQuery>;

	/// Events emitted by this pallet.
	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A new claim was created.
		ClaimCreated {
			/// The account that created the claim.
			who: T::AccountId,
			/// The hash that was claimed.
			hash: H256,
		},
		/// A claim was revoked by its owner.
		ClaimRevoked {
			/// The account that revoked the claim.
			who: T::AccountId,
			/// The hash that was revoked.
			hash: H256,
		},
	}

	/// Errors that can occur in this pallet.
	#[pallet::error]
	pub enum Error<T> {
		/// This hash has already been claimed.
		AlreadyClaimed,
		/// The caller is not the owner of this claim.
		NotClaimOwner,
		/// No claim exists for this hash.
		ClaimNotFound,
	}

	/// Dispatchable calls.
	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Create a new proof-of-existence claim for the given hash.
		///
		/// The hash must not already be claimed. The caller becomes the owner,
		/// and the current block number is recorded.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::create_claim())]
		pub fn create_claim(origin: OriginFor<T>, hash: H256) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(!Claims::<T>::contains_key(hash), Error::<T>::AlreadyClaimed);
			let block_number = frame_system::Pallet::<T>::block_number();
			Claims::<T>::insert(hash, Claim { owner: who.clone(), block_number });
			Self::deposit_event(Event::ClaimCreated { who, hash });
			Ok(())
		}

		/// Revoke an existing proof-of-existence claim.
		///
		/// Only the original claim owner can revoke it. The storage entry is removed.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::revoke_claim())]
		pub fn revoke_claim(origin: OriginFor<T>, hash: H256) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let claim = Claims::<T>::get(hash).ok_or(Error::<T>::ClaimNotFound)?;
			ensure!(claim.owner == who, Error::<T>::NotClaimOwner);
			Claims::<T>::remove(hash);
			Self::deposit_event(Event::ClaimRevoked { who, hash });
			Ok(())
		}
	}
}
