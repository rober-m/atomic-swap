import { describe, expect, it } from "vitest";

import {
  getBundledValidators,
  hasBundledBlueprint,
  SwapContract,
} from "./contract.js";

// The blueprint is bundled before tests run (the npm "pretest" hook calls
// scripts/bundle-blueprint.mjs), so these run only once the on-chain component
// has been built. They need no wallet or network — script and address
// derivation are pure.
const bundled = hasBundledBlueprint();

describe("Swap off-chain", () => {
  it.runIf(bundled)("bundles the swap validator from the blueprint", () => {
    const { swap } = getBundledValidators();
    expect(swap.length).toBeGreaterThan(0);
  });

  it.runIf(bundled)(
    "derives the swap script address from the bundled blueprint",
    () => {
      // No validators passed — the contract uses the bundled blueprint.
      const contract = new SwapContract({
        // Pure derivation does not touch these; cast for the offline test.
        fetcher: undefined as never,
        submitter: undefined as never,
        wallet: undefined as never,
        networkId: 0,
      });

      const { swapScript, swapAddress } = contract.getScripts();

      expect(swapScript.length).toBeGreaterThan(0);
      // Preview/preprod script addresses are bech32 with the `addr_test` HRP.
      expect(swapAddress.startsWith("addr_test")).toBe(true);
    },
  );
});
