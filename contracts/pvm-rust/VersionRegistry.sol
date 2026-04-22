// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVersionRegistry — Multi-contract version registry.
/// @notice Tracks deployed contract implementation addresses by name and version.
/// Each contract family (e.g. "covered-call", "futures") has its own
/// independent version chain. Only the owner can register new versions.
interface IVersionRegistry {
    // --- Events ---

    event VersionRegistered(
        bytes32 indexed name,
        uint256 indexed version,
        address indexed implementation
    );

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    // --- Errors ---

    error NotOwner();
    error InvalidAddress();
    error VersionNotFound();
    error UnknownSelector();

    // --- Write Functions ---

    /// @notice Register a new implementation for a named contract.
    ///         Auto-increments the version counter for that name.
    /// @param name The contract family identifier (e.g. bytes32("covered-call"))
    /// @param implementation The deployed contract address
    /// @return version The assigned version number (1-indexed)
    function registerVersion(bytes32 name, address implementation) external returns (uint256 version);

    /// @notice Transfer ownership of the registry.
    /// @param newOwner The new owner address
    function transferOwnership(address newOwner) external;

    // --- View Functions ---

    /// @notice Get the latest implementation for a named contract.
    /// @param name The contract family identifier
    function latest(bytes32 name) external view returns (address);

    /// @notice Get a specific version's implementation.
    /// @param name The contract family identifier
    /// @param version The version number (1-indexed)
    function getVersion(bytes32 name, uint256 version) external view returns (address);

    /// @notice Get the number of registered versions for a named contract.
    /// @param name The contract family identifier
    function versionCount(bytes32 name) external view returns (uint256);

    /// @notice Get the contract owner.
    function owner() external view returns (address);
}
