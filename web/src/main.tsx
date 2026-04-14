import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import "./index.css";

const HomePage = lazy(() => import("./pages/HomePage"));
const PalletPage = lazy(() => import("./pages/PalletPage"));
const EvmContractPage = lazy(() => import("./pages/EvmContractPage"));
const PvmContractPage = lazy(() => import("./pages/PvmContractPage"));
const DexPage = lazy(() => import("./pages/DexPage"));
const AccountsPage = lazy(() => import("./pages/AccountsPage"));
const StatementStorePage = lazy(() => import("./pages/StatementStorePage"));

const routeFallback = (
	<div className="card animate-pulse">
		<div className="h-4 w-32 rounded bg-white/[0.06]" />
		<div className="mt-3 h-3 w-48 rounded bg-white/[0.04]" />
	</div>
);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<HashRouter>
			<Routes>
				<Route element={<App />}>
					<Route
						index
						element={
							<Suspense fallback={routeFallback}>
								<HomePage />
							</Suspense>
						}
					/>
					<Route
						path="pallet"
						element={
							<Suspense fallback={routeFallback}>
								<PalletPage />
							</Suspense>
						}
					/>
					<Route
						path="evm"
						element={
							<Suspense fallback={routeFallback}>
								<EvmContractPage />
							</Suspense>
						}
					/>
					<Route
						path="pvm"
						element={
							<Suspense fallback={routeFallback}>
								<PvmContractPage />
							</Suspense>
						}
					/>
					<Route
						path="dex"
						element={
							<Suspense fallback={routeFallback}>
								<DexPage />
							</Suspense>
						}
					/>
					<Route
						path="accounts"
						element={
							<Suspense fallback={routeFallback}>
								<AccountsPage />
							</Suspense>
						}
					/>
					<Route
						path="statements"
						element={
							<Suspense fallback={routeFallback}>
								<StatementStorePage />
							</Suspense>
						}
					/>
				</Route>
			</Routes>
		</HashRouter>
	</StrictMode>,
);
