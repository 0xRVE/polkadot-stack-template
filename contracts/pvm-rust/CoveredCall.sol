// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ICoveredCall — Covered call options backed by ERC20 collateral.
/// @notice Assets are identified by their SCALE-encoded AssetKind (`bytes`).
/// The caller must `approve` this contract via the ERC20 precompile at 0x0120
/// before calling writeOption, buyOption, or exerciseOption.
/// Uses the asset-conversion precompile at 0x0420 for in-the-money price checks.
interface ICoveredCall {
    // --- Events ---

    event OptionWritten(
        uint256 indexed optionId,
        address indexed writer,
        uint256 amount,
        uint256 strike,
        uint256 premium,
        uint256 expiry
    );

    event OptionBought(
        uint256 indexed optionId,
        address indexed owner
    );

    event OptionResale(
        uint256 indexed optionId,
        address indexed owner,
        uint256 askPrice
    );

    event OptionExercised(
        uint256 indexed optionId,
        address indexed owner
    );

    event OptionExpired(
        uint256 indexed optionId,
        address indexed writer
    );

    event OptionCancelled(
        uint256 indexed optionId,
        address indexed writer
    );

    event OptionDelisted(
        uint256 indexed optionId,
        address indexed owner
    );

    // --- Errors ---

    error PrecompileCallFailed();
    error TransferFromFailed();
    error OptionNotActive();
    error OptionNotListed();
    error OptionNotExpired();
    error OptionAlreadyExpired();
    error NotOptionOwner();
    error UnauthorizedCancel();
    error OptionNotResale();
    error NotInTheMoney();
    error InvalidAsset();
    error InvalidAmount();
    error InvalidStrike();
    error InvalidExpiry();
    error Overflow();

    // --- Write Functions ---

    /// @notice Write (sell) a covered call option. Deposits underlying ERC20 as collateral.
    /// @param underlying SCALE-encoded asset identifier for the underlying token
    /// @param strikeAsset SCALE-encoded asset identifier for the strike token
    /// @param amount Amount of underlying to deposit as collateral
    /// @param strike Total amount of strike asset the owner pays to exercise
    /// @param premium Price to buy (acquire) the option, denominated in strike asset
    /// @param expiry Unix timestamp (seconds) at which the option expires
    /// @return optionId The ID of the newly created option
    function writeOption(
        bytes calldata underlying,
        bytes calldata strikeAsset,
        uint256 amount,
        uint256 strike,
        uint256 premium,
        uint256 expiry
    ) external returns (uint256 optionId);

    /// @notice Buy an option from the orderbook. Pays the premium (first sale) or
    ///         ask price (resale) to the writer/current owner.
    /// @param optionId The option to buy
    function buyOption(uint256 optionId) external;

    /// @notice List a bought option for resale on the secondary market.
    ///         Can also be called on an already-listed option to update the ask price.
    /// @param optionId The option to resell
    /// @param askPrice Price in strike asset that the next buyer must pay
    function resellOption(uint256 optionId, uint256 askPrice) external;

    /// @notice Remove a resale listing, returning the option to Active status.
    ///         Only the current owner can delist.
    /// @param optionId The option to delist
    function delistOption(uint256 optionId) external;

    /// @notice Cancel a listed option that hasn't been bought yet.
    ///         Only the writer can cancel. Returns collateral to writer.
    /// @param optionId The option to cancel
    function cancelOption(uint256 optionId) external;

    /// @notice Exercise an active option before expiry. Only the owner can exercise.
    ///         Owner pays the strike amount of strike asset directly to the writer
    ///         and receives the underlying collateral.
    ///         Only exercisable when the option is in-the-money (market value > strike).
    /// @param optionId The option to exercise
    function exerciseOption(uint256 optionId) external;

    /// @notice Reclaim collateral after option expiry.
    /// @param optionId The expired option
    function expireOption(uint256 optionId) external;

    // --- View Functions ---

    /// @notice Read option details.
    function getOption(uint256 optionId) external view returns (
        address writer,
        bytes memory underlying,
        bytes memory strikeAsset,
        uint256 amount,
        uint256 strike,
        uint256 premium,
        uint256 expiry,
        uint256 created,
        address owner,
        uint256 askPrice,
        uint256 status
    );

    /// @notice Get the total number of options written.
    function nextOptionId() external view returns (uint256);
}
