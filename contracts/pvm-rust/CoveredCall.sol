// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ICoveredCall — Covered call options backed by ERC20 collateral.
/// @notice Assets are identified by their SCALE-encoded AssetKind (`bytes`).
/// The caller must `approve` this contract via the ERC20 precompile at 0x0120
/// before calling writeOption or exerciseOption.
/// Uses the asset-conversion precompile at 0x0420 for in-the-money price checks.
interface ICoveredCall {
    // --- Events ---

    event OptionWritten(
        uint256 indexed optionId,
        address indexed seller,
        uint256 amount,
        uint256 strikePrice,
        uint256 expiry
    );

    event OptionExercised(
        uint256 indexed optionId,
        address indexed buyer
    );

    event OptionExpired(
        uint256 indexed optionId,
        address indexed seller
    );

    // --- Errors ---

    error PrecompileCallFailed();
    error TransferFromFailed();
    error OptionNotActive();
    error OptionNotExpired();
    error OptionAlreadyExpired();
    error NotInTheMoney();
    error InvalidAsset();
    error InvalidAmount();
    error InvalidExpiry();

    // --- Write Functions ---

    /// @notice Write (sell) a covered call option. Deposits underlying ERC20 as collateral.
    /// @param underlying SCALE-encoded asset identifier for the underlying token
    /// @param strikeAsset SCALE-encoded asset identifier for the strike token
    /// @param amount Amount of underlying to deposit as collateral
    /// @param strikePrice Price per unit in strike asset terms
    /// @param expiry Block number at which the option expires
    /// @return optionId The ID of the newly created option
    function writeOption(
        bytes calldata underlying,
        bytes calldata strikeAsset,
        uint256 amount,
        uint256 strikePrice,
        uint256 expiry
    ) external returns (uint256 optionId);

    /// @notice Exercise an active option before expiry. Buyer pays strikePrice * amount
    ///         of the strike asset directly to the seller and receives the underlying collateral.
    ///         Only exercisable when the option is in-the-money (market value > strike cost).
    /// @param optionId The option to exercise
    function exerciseOption(uint256 optionId) external;

    /// @notice Reclaim collateral after option expiry.
    /// @param optionId The expired option
    function expireOption(uint256 optionId) external;

    // --- View Functions ---

    /// @notice Read option details.
    function getOption(uint256 optionId) external view returns (
        address seller,
        bytes memory underlying,
        bytes memory strikeAsset,
        uint256 amount,
        uint256 strikePrice,
        uint256 expiry,
        uint256 status
    );

    /// @notice Get the total number of options written.
    function nextOptionId() external view returns (uint256);
}
