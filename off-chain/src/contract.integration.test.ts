import { existsSync } from "node:fs";

import { config as loadDotenv } from "dotenv";
import { MeshWallet, YaciProvider } from "@meshsdk/core";
import { describe, expect, it } from "vitest";

import { hasBundledBlueprint, SwapContract } from "./contract.js";

// End-to-end integration test: a full lock→accept round-trip between two parties
// against a real local devnet (Yaci DevKit). Person A locks assets asking a
// price; Person B accepts, paying A and taking the locked assets. It is gated so
// it runs ONLY when a devnet is available and the on-chain blueprint has been
// built:
//
//   • INDEXER_URL — written to ../.env by `just -f test/Justfile dev`, or
//     exported by the testing component's ephemeral `just test`.
//   • a bundled blueprint — produced by the on-chain `just build`.
//
// Otherwise it skips, so `just test` stays green with no devnet. This file ends
// in `.test.ts`, so it is excluded from the library build (tsconfig) and never
// reaches the importable package — only the unit-tested `contract.ts` does.

for (const path of ["../.env", ".env.local", ".env"]) {
  if (existsSync(path)) loadDotenv({ path, override: false });
}

const indexerUrl = (process.env.INDEXER_URL ?? "").trim();
const adminUrl = (process.env.YACI_ADMIN_URL ?? "http://localhost:10000").trim();
const canRun = indexerUrl !== "" && hasBundledBlueprint();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until `ok(result)` or we run out of tries. */
async function poll<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  tries = 60,
  ms = 1000,
): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    await wait(ms);
  }
  throw new Error("timed out waiting for the devnet to reach the expected state");
}

/**
 * Wait until a submitted tx is on-chain (its outputs are queryable). The
 * indexer returns 404 for a not-yet-included tx, so tolerate errors and retry.
 */
async function confirmed(
  provider: YaciProvider,
  txHash: string,
  tries = 60,
  ms = 1000,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const utxos = await provider.fetchUTxOs(txHash);
      if (utxos.length > 0) return;
    } catch {
      // not indexed yet — keep waiting
    }
    await wait(ms);
  }
  throw new Error(`tx ${txHash} was not confirmed on the devnet in time`);
}

/** A fresh throwaway wallet, funded from the faucet with collateral + funds. */
async function fundedWallet(provider: YaciProvider): Promise<MeshWallet> {
  // brew() returns the mnemonic words; tolerate string or string[].
  const brewed = MeshWallet.brew();
  const words = Array.isArray(brewed) ? brewed : String(brewed).split(" ");
  const wallet = new MeshWallet({
    networkId: 0,
    fetcher: provider,
    submitter: provider,
    key: { type: "mnemonic", words },
  });
  await wallet.init();
  const address = await wallet.getChangeAddress();

  // A small UTxO usable as collateral + a large one to spend. NOTE: Yaci's
  // topup amount is in ADA, not lovelace.
  await provider.addressTopup(address, "10"); // 10 ADA (collateral)
  await provider.addressTopup(address, "10000"); // 10,000 ADA (funds)
  await poll(
    () => provider.fetchAddressUTxOs(address),
    (utxos) => utxos.length >= 2,
  );
  return wallet;
}

(canRun ? describe : describe.skip)("Atomic swap round-trip on a Yaci devnet", () => {
  it("A locks assets asking a price, then B accepts and pays A", async () => {
    const provider = new YaciProvider(indexerUrl, adminUrl);

    // Two independent parties, each with their own funded wallet.
    const walletA = await fundedWallet(provider);
    const walletB = await fundedWallet(provider);

    const contractA = new SwapContract({
      fetcher: provider,
      submitter: provider,
      wallet: walletA,
      networkId: 0,
    });
    const contractB = new SwapContract({
      fetcher: provider,
      submitter: provider,
      wallet: walletB,
      networkId: 0,
    });

    // A locks 5 ADA, asking 3 ADA in return.
    const lockTx = await contractA.signAndSubmit(
      await contractA.lock(
        [{ unit: "lovelace", quantity: "5000000" }],
        [{ unit: "lovelace", quantity: "3000000" }],
      ),
    );
    await confirmed(provider, lockTx);

    const swapUtxo = await contractA.getSwapUtxo(lockTx);
    expect(swapUtxo, "the lock tx should produce a swap UTxO").toBeDefined();

    // The datum records A as the owner and 3 ADA as the price.
    const terms = contractA.readTerms(swapUtxo!);
    expect(terms.price).toEqual([{ unit: "lovelace", quantity: "3000000" }]);

    // B accepts: takes the locked 5 ADA and pays A the 3 ADA price.
    const acceptTx = await contractB.signAndSubmit(await contractB.accept(swapUtxo!));
    await confirmed(provider, acceptTx);
    expect(acceptTx).toMatch(/^[0-9a-f]{64}$/);
  }, 240_000);
});
