fn main() {
	let target = std::env::var("TARGET").unwrap_or_default();
	if !target.contains("polkavm") {
		// Skip PVM cross-compilation when building for a host target (e.g. tests).
		return;
	}
	cargo_pvm_contract_builder::PvmBuilder::new().build();
}
