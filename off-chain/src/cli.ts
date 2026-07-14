import { Asset } from "@meshsdk/core";

import { getBundledValidators, hasBundledBlueprint } from "./contract.js";
import { createSwapContractFromEnv, loadEnv, topupOnDevnet } from "./node.js";

/** A one-line, human description of where transactions will go. */
function describeProvider(provider: {
  kind: "yaci" | "blockfrost";
  url?: string;
}): string {
  return provider.kind === "yaci"
    ? `local devnet at ${provider.url} (Yaci)`
    : "Blockfrost";
}

// Runnable entry point for `just dev` / `npm start` and the lock / accept /
// cancel commands. It submits real transactions when the blueprint is bundled
// and the required environment variables are present, and degrades to guidance
// otherwise. The blueprint is bundled from ../blueprint/plutus.json before this
// runs (the npm "pre" hooks call scripts/bundle-blueprint.mjs).
//
//   npm start                                          # status: blueprint + env
//   npx tsx src/cli.ts lock <lockLovelace> <askLovelace>
//   npx tsx src/cli.ts accept <lockTxHash>
//   npx tsx src/cli.ts cancel <lockTxHash>

function printStatus(): void {
  if (!hasBundledBlueprint()) {
    console.log("No blueprint bundled.");
    console.log(
      "Build the on-chain component first:  just -f ../on-chain/Justfile build",
    );
    return;
  }

  const { swap } = getBundledValidators();
  console.log("Bundled on-chain blueprint:");
  console.log(`  swap (spend): ${swap.length} hex chars`);
  console.log("");

  const env = loadEnv();
  if (env.ok) {
    console.log(
      `Environment ready (network: ${env.env.network}, ` +
        `provider: ${describeProvider(env.env.provider)}).`,
    );
    console.log("Run a transaction:");
    console.log("  npx tsx src/cli.ts lock <lockLovelace> <askLovelace>");
    console.log("  npx tsx src/cli.ts accept <lockTxHash>");
    console.log("  npx tsx src/cli.ts cancel <lockTxHash>");
  } else {
    console.log("To submit transactions, set the following (see .env.example):");
    for (const key of env.missing) console.log(`  - ${key}`);
  }
}

function requireEnv() {
  if (!hasBundledBlueprint()) {
    throw new Error(
      "No blueprint bundled. Build on-chain first: " +
        "just -f ../on-chain/Justfile build",
    );
  }
  const env = loadEnv();
  if (!env.ok) {
    throw new Error(
      `Missing required configuration: ${env.missing.join(", ")}. ` +
        "See .env.example.",
    );
  }
  return env.env;
}

const ada = (lovelace: string): Asset => ({ unit: "lovelace", quantity: lovelace });

async function lock(lockLovelace: string, askLovelace: string): Promise<void> {
  const env = requireEnv();
  const { contract, wallet, provider } = await createSwapContractFromEnv({ env });

  // On a local devnet, top the wallet up from the faucet so a fresh wallet has
  // funds + collateral. Amount is in ADA. No-op (and not needed) on Blockfrost.
  const address = await wallet.getChangeAddress();
  const topped = await topupOnDevnet(provider, address, "10000"); // 10,000 ADA
  if (topped) console.log(`Funded ${address.slice(0, 20)}… from the devnet faucet.`);

  // Lock `lockLovelace`, asking `askLovelace` in return.
  const unsignedTx = await contract.lock([ada(lockLovelace)], [ada(askLovelace)]);
  const txHash = await contract.signAndSubmit(unsignedTx);

  console.log(
    `Locked ${lockLovelace} lovelace, asking ${askLovelace} lovelace in return.`,
  );
  console.log(`  tx: ${txHash}`);
  console.log("Once it is confirmed on chain, anyone can accept it with:");
  console.log(`  npx tsx src/cli.ts accept ${txHash}`);
  console.log("or you can reclaim it with:");
  console.log(`  npx tsx src/cli.ts cancel ${txHash}`);
}

async function accept(lockTxHash: string): Promise<void> {
  const env = requireEnv();
  const { contract } = await createSwapContractFromEnv({ env });

  const swapUtxo = await contract.getSwapUtxo(lockTxHash);
  if (swapUtxo === undefined) {
    throw new Error(
      `No swap UTxO (output with an inline datum) found in tx ${lockTxHash}.`,
    );
  }

  const unsignedTx = await contract.accept(swapUtxo);
  const txHash = await contract.signAndSubmit(unsignedTx);

  console.log("Swap accepted; you paid the owner and took the locked assets.");
  console.log(`  tx: ${txHash}`);
}

async function cancel(lockTxHash: string): Promise<void> {
  const env = requireEnv();
  const { contract } = await createSwapContractFromEnv({ env });

  const swapUtxo = await contract.getSwapUtxo(lockTxHash);
  if (swapUtxo === undefined) {
    throw new Error(
      `No swap UTxO (output with an inline datum) found in tx ${lockTxHash}.`,
    );
  }

  const unsignedTx = await contract.cancel(swapUtxo);
  const txHash = await contract.signAndSubmit(unsignedTx);

  console.log("Swap cancelled; locked assets returned to you.");
  console.log(`  tx: ${txHash}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "status":
      printStatus();
      break;
    case "lock":
      if (args.length < 2) {
        throw new Error("usage: lock <lockLovelace> <askLovelace>");
      }
      await lock(args[0]!, args[1]!);
      break;
    case "accept":
      if (args.length < 1) {
        throw new Error("usage: accept <lockTxHash>");
      }
      await accept(args[0]!);
      break;
    case "cancel":
      if (args.length < 1) {
        throw new Error("usage: cancel <lockTxHash>");
      }
      await cancel(args[0]!);
      break;
    default:
      throw new Error(
        `Unknown command "${command}". Use: status | lock | accept | cancel`,
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
