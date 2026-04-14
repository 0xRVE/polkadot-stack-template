// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IDexRouter - Router contract wrapping the asset-conversion precompile.
/// @notice Provides simplified swap, quote, and pool management for the on-chain DEX.
/// Assets are identified by their SCALE-encoded AssetKind passed as `bytes`.
interface IDexRouter {
    // --- Events ---

    event SwapExecuted(
        address indexed sender,
        uint256 amountIn,
        uint256 amountOut
    );

    event PoolCreated(
        address indexed creator
    );

    event LiquidityAdded(
        address indexed provider,
        uint256 amount1,
        uint256 amount2
    );

    event LiquidityRemoved(
        address indexed provider,
        uint256 lpTokensBurned
    );

    // --- Errors ---

    error PrecompileCallFailed();
    error SlippageExceeded();

    // --- Swap ---

    /// @notice Swap an exact amount of input tokens for output tokens.
    /// Sends output to the caller.
    function swapExactIn(
        bytes[] calldata path,
        uint256 amountIn,
        uint256 amountOutMin
    ) external returns (uint256 amountOut);

    /// @notice Swap tokens to receive an exact output amount.
    /// Sends output to the caller.
    function swapExactOut(
        bytes[] calldata path,
        uint256 amountOut,
        uint256 amountInMax
    ) external returns (uint256 amountIn);

    // --- Quotes ---

    /// @notice Get expected output for a given input amount.
    function getAmountOut(
        bytes calldata assetIn,
        bytes calldata assetOut,
        uint256 amountIn
    ) external view returns (uint256 amountOut);

    /// @notice Get required input for a desired output amount.
    function getAmountIn(
        bytes calldata assetIn,
        bytes calldata assetOut,
        uint256 amountOut
    ) external view returns (uint256 amountIn);

    // --- Pool Management ---

    /// @notice Create a new liquidity pool for the given asset pair.
    function createPool(
        bytes calldata asset1,
        bytes calldata asset2
    ) external;

    /// @notice Add liquidity to an existing pool.
    function addLiquidity(
        bytes calldata asset1,
        bytes calldata asset2,
        uint256 amount1Desired,
        uint256 amount2Desired,
        uint256 amount1Min,
        uint256 amount2Min
    ) external returns (uint256 liquidity);

    /// @notice Remove liquidity from a pool.
    function removeLiquidity(
        bytes calldata asset1,
        bytes calldata asset2,
        uint256 lpTokenBurn,
        uint256 amount1Min,
        uint256 amount2Min
    ) external returns (uint256 amount1, uint256 amount2);

    // --- Convenience ---

    /// @notice Create a pool and add initial liquidity in one call.
    function createPoolAndAdd(
        bytes calldata asset1,
        bytes calldata asset2,
        uint256 amount1Desired,
        uint256 amount2Desired,
        uint256 amount1Min,
        uint256 amount2Min
    ) external returns (uint256 liquidity);
}
