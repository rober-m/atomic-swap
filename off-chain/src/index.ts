// Library entry point. Re-exports the framework-agnostic core so the package
// can be imported from a backend or a frontend:
//
//   import { SwapContract, getSwapValidators } from "atomic-swap-off-chain";
//
// Node-only helpers (reading the blueprint from disk, building a wallet from
// environment variables) live behind the "atomic-swap-off-chain/node"
// subpath so they never reach a browser bundle.
export * from "./contract.js";
