import { mConStr0, mConStr1 } from "@meshsdk/common";
import {
  Asset,
  DEFAULT_V1_COST_MODEL_LIST,
  DEFAULT_V2_COST_MODEL_LIST,
  DEFAULT_V3_COST_MODEL_LIST,
  deserializeAddress,
  deserializeDatum,
  IEvaluator,
  IFetcher,
  ISubmitter,
  MeshTxBuilder,
  pubKeyAddress,
  serializeAddressObj,
  serializePlutusScript,
  UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-cst";

import { bundledBlueprint } from "./blueprint.generated.js";

// Core, framework-agnostic bindings for the atomic-swap contract. This module
// has no Node-only dependencies (no `fs`), so it is safe to import in a browser
// frontend as well as a backend. The on-chain blueprint is bundled in at build
// time from ../blueprint/plutus.json (see scripts/bundle-blueprint.mjs), so the
// contract always knows its validator — consumers never supply it.
//
// Protocol
// --------
// Person A LOCKS some assets at the swap script address, attaching an inline
// datum that states who must be paid (A), the `price` A is asking for, and a
// unique `tag`. Any Person B can then ACCEPT the swap by spending that UTxO,
// provided the transaction contains exactly one output that pays A at least the
// `price` and carries the same `tag`. B keeps the locked assets; A receives the
// price — atomically, in one transaction. A can also CANCEL an unaccepted swap
// and reclaim the locked assets by signing.

/** Plutus language version the on-chain validator is compiled to. */
export const LANGUAGE_VERSION = "V3" as const;

/** Minimum lovelace to attach to a payment output that is otherwise token-only,
 * so it satisfies the ledger's min-UTxO rule. Any excess simply benefits the
 * owner and never fails the on-chain price check. */
const MIN_PAYMENT_LOVELACE = "2000000";

/**
 * Shape of the CIP-57 blueprint produced by the on-chain `aiken build`. Only
 * the fields this library reads are named; the index signatures tolerate the
 * many other fields a real plutus.json carries (preamble, redeemer, datum, …).
 */
export type Blueprint = {
  validators: { title: string; compiledCode: string; [key: string]: unknown }[];
  [key: string]: unknown;
};

/** The single compiled validator the swap flow needs. */
export type SwapValidators = {
  /** Compiled code of the `swap` spending validator. */
  swap: string;
};

/**
 * The swap script and its derived on-chain address. Useful on a frontend to
 * display the script address without building a transaction.
 */
export type SwapScripts = {
  swapScript: string;
  swapAddress: string;
};

/** One asset in a swap `price`: `lovelace` uses unit `"lovelace"`. */
export type PricedAsset = { policy: string; name: string; quantity: string };

/** The swap datum, as read back off-chain from a locked UTxO. */
export type SwapTerms = {
  /** Payment key hash of the person who must be paid (Person A). */
  owner: string;
  /** Minimum assets that must be paid to `owner` to take the locked value. */
  price: Asset[];
  /** Unique tag binding a payment output to this specific swap. */
  tag: string;
};

// Aiken prefixes validator titles with their module name, e.g. "swap.swap.spend".
// We match on the "<validator>.<purpose>" suffix so the lookup is independent of
// the module (file) name.
export function findValidator(blueprint: Blueprint, suffix: string): string {
  const validator = blueprint.validators.find(
    (v) => v.title === suffix || v.title.endsWith(`.${suffix}`),
  );
  if (!validator) {
    const known = blueprint.validators.map((v) => v.title).join(", ");
    throw new Error(
      `Validator "${suffix}" not found in blueprint. Available: ${known}`,
    );
  }
  return validator.compiledCode;
}

/** Pull the swap (spend) validator out of a blueprint. */
export function getSwapValidators(blueprint: Blueprint): SwapValidators {
  return {
    swap: findValidator(blueprint, "swap.spend"),
  };
}

/** The blueprint inlined at build time, or null if none was bundled. */
export { bundledBlueprint };

/** Whether a blueprint was bundled into this build. */
export function hasBundledBlueprint(): boolean {
  return bundledBlueprint !== null;
}

/**
 * The swap validator bundled at build time. Throws if none was bundled — build
 * the on-chain component and run the off-chain `just build`.
 */
export function getBundledValidators(): SwapValidators {
  if (bundledBlueprint === null) {
    throw new Error(
      "No blueprint was bundled into this build. Build the on-chain component " +
        "(its `just build` writes ../blueprint/plutus.json), then run the " +
        "off-chain `just build`.",
    );
  }
  return getSwapValidators(bundledBlueprint);
}

/** Split an asset unit into its (policy id, hex asset name) parts. */
function splitUnit(unit: string): { policy: string; name: string } {
  if (unit === "lovelace" || unit === "") return { policy: "", name: "" };
  return { policy: unit.slice(0, 56), name: unit.slice(56) };
}

/** Join a (policy id, hex asset name) back into an asset unit. */
function joinUnit(policy: string, name: string): string {
  return policy === "" ? "lovelace" : policy + name;
}

/**
 * Minimal wallet surface the contract needs. Both MeshWallet (backend) and
 * BrowserWallet (frontend) satisfy this structurally, so the library is not
 * tied to a particular wallet implementation.
 */
export interface SwapWallet {
  getUtxos(): Promise<UTxO[]>;
  getCollateral(): Promise<UTxO[]>;
  getChangeAddress(): Promise<string>;
  signTx(unsignedTx: string, partialSign?: boolean): Promise<string>;
  submitTx(tx: string): Promise<string>;
}

export type SwapContractInput = {
  /** Reads chain state (UTxOs). A provider such as BlockfrostProvider works. */
  fetcher: IFetcher;
  /** Submits signed transactions. A provider such as BlockfrostProvider works. */
  submitter: ISubmitter;
  /**
   * Computes Plutus script execution units for the transaction. Required for
   * the on-chain script to balance correctly — providers such as
   * BlockfrostProvider and YaciProvider implement this. Defaults to the
   * `submitter` when it also implements `IEvaluator` (both providers do).
   */
  evaluator?: IEvaluator;
  /** The wallet that funds, signs, and submits. */
  wallet: SwapWallet;
  /** 0 for testnets (preview/preprod), 1 for mainnet. */
  networkId: number;
};

export class SwapContract {
  private readonly fetcher: IFetcher;
  private readonly submitter: ISubmitter;
  private readonly evaluator?: IEvaluator;
  private readonly wallet: SwapWallet;
  private readonly networkId: number;
  private readonly swapCompiledCode: string;

  constructor(input: SwapContractInput) {
    this.fetcher = input.fetcher;
    this.submitter = input.submitter;
    // Fall back to the submitter as evaluator (BlockfrostProvider / YaciProvider
    // implement IEvaluator), so Plutus ex-units are computed without extra wiring.
    this.evaluator =
      input.evaluator ??
      (input.submitter != null &&
      typeof (input.submitter as { evaluateTx?: unknown }).evaluateTx === "function"
        ? (input.submitter as unknown as IEvaluator)
        : undefined);
    this.wallet = input.wallet;
    this.networkId = input.networkId;
    // The blueprint carries the flat compiled code; CBOR-encode it once (the
    // validator takes no parameters, so this is a plain wrap) into the form the
    // ledger and MeshJS expect for hashing, address derivation, and spending.
    this.swapCompiledCode = applyParamsToScript(getBundledValidators().swap, []);
  }

  /** A fresh transaction builder. One builder builds one transaction. */
  private newTxBuilder(): MeshTxBuilder {
    const builder = new MeshTxBuilder({
      fetcher: this.fetcher,
      submitter: this.submitter,
      evaluator: this.evaluator,
    });
    // Pin the Plutus cost models the script-data hash is computed from. These
    // are the current protocol-era constants (identical to what every Cardano
    // network uses), so tx building is deterministic and doesn't depend on the
    // provider implementing `fetchCostModels` — MeshJS's YaciProvider does not,
    // and without this the builder logs an alarming-looking (but harmless)
    // fallback. To instead use a provider's network-fetched cost models, drop
    // this call (BlockfrostProvider supports it; YaciProvider does not yet).
    builder.setNetwork([
      DEFAULT_V1_COST_MODEL_LIST,
      DEFAULT_V2_COST_MODEL_LIST,
      DEFAULT_V3_COST_MODEL_LIST,
    ]);
    return builder;
  }

  private getScriptAddress(scriptCbor: string): string {
    return serializePlutusScript(
      { code: scriptCbor, version: LANGUAGE_VERSION },
      undefined,
      this.networkId,
    ).address;
  }

  /**
   * The swap script and its on-chain address. The validator is not
   * parameterised, so there is a single address shared by every swap. Pure: no
   * wallet or network access, so it is safe to call from a frontend.
   */
  getScripts(): SwapScripts {
    return {
      swapScript: this.swapCompiledCode,
      swapAddress: this.getScriptAddress(this.swapCompiledCode),
    };
  }

  /** Build the inline datum (owner pkh, price, tag) attached to a locked UTxO. */
  private buildDatum(owner: string, price: Asset[], tag: string) {
    const pricedAssets = price.map((asset) => {
      const { policy, name } = splitUnit(asset.unit);
      return mConStr0([policy, name, BigInt(asset.quantity)]);
    });
    return mConStr0([owner, pricedAssets, tag]);
  }

  /** Read the swap terms back out of a locked UTxO's inline datum. */
  readTerms(swapUtxo: UTxO): SwapTerms {
    if (swapUtxo.output.plutusData === undefined) {
      throw new Error("UTxO has no inline datum; it is not a swap UTxO");
    }
    // The datum is Constr0 [ owner: bytes, price: [Constr0 [policy, name, qty]], tag: bytes ].
    const datum = deserializeDatum<{ fields: unknown[] }>(
      swapUtxo.output.plutusData,
    );
    const owner = (datum.fields[0] as { bytes: string }).bytes;
    const priceList = (datum.fields[1] as { list: { fields: unknown[] }[] }).list;
    const tag = (datum.fields[2] as { bytes: string }).bytes;

    const price: Asset[] = priceList.map((item) => {
      const policy = (item.fields[0] as { bytes: string }).bytes;
      const name = (item.fields[1] as { bytes: string }).bytes;
      const quantity = (item.fields[2] as { int: number | bigint }).int;
      return { unit: joinUnit(policy, name), quantity: quantity.toString() };
    });

    return { owner, price, tag };
  }

  private async getWalletInfoForTx(): Promise<{
    utxos: UTxO[];
    walletAddress: string;
    collateral: UTxO;
  }> {
    const utxos = await this.wallet.getUtxos();
    const collateral = (await this.wallet.getCollateral())[0];
    const walletAddress = await this.wallet.getChangeAddress();
    if (utxos.length === 0) throw new Error("No UTxOs found in wallet");
    if (collateral === undefined)
      throw new Error("No collateral UTxO found in wallet");
    return { utxos, walletAddress, collateral };
  }

  /**
   * Build a transaction that LOCKS `lockedAssets` at the swap script address,
   * asking `price` in return. Called by Person A. The unique `tag` bound into
   * the datum is derived from a wallet UTxO that this transaction spends, so it
   * is globally unique and cannot be reused to double-satisfy another swap.
   * Returns the UNSIGNED transaction hex.
   */
  lock = async (lockedAssets: Asset[], price: Asset[]): Promise<string> => {
    const { utxos, walletAddress, collateral } = await this.getWalletInfoForTx();
    const seed = utxos[0];
    if (seed === undefined) throw new Error("No UTxOs available");
    const remainingUtxos = utxos.slice(1);

    const owner = deserializeAddress(walletAddress).pubKeyHash;
    // A unique tag: the seed UTxO's (txHash, index) can only ever be spent once.
    const tag =
      seed.input.txHash + seed.input.outputIndex.toString(16).padStart(2, "0");
    const { swapAddress } = this.getScripts();

    const tx = await this.newTxBuilder()
      // Spend the seed UTxO so the tag it feeds is truly one-shot.
      .txIn(
        seed.input.txHash,
        seed.input.outputIndex,
        seed.output.amount,
        seed.output.address,
      )
      .txOut(swapAddress, lockedAssets)
      .txOutInlineDatumValue(this.buildDatum(owner, price, tag))
      .changeAddress(walletAddress)
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address,
      )
      .selectUtxosFrom(remainingUtxos)
      .complete();

    return tx;
  };

  /**
   * Build a transaction that ACCEPTS the swap sitting at `swapUtxo`: it spends
   * the locked UTxO (releasing the assets to the caller, Person B) and pays the
   * owner the asked `price` in a single output tagged with the swap's `tag`.
   * Called by Person B. Returns the UNSIGNED transaction hex.
   */
  accept = async (swapUtxo: UTxO): Promise<string> => {
    const { utxos, walletAddress, collateral } = await this.getWalletInfoForTx();
    const { owner, price, tag } = this.readTerms(swapUtxo);
    const { swapScript } = this.getScripts();

    // Reconstruct the owner's (payment-only) address from the key hash in the
    // datum; the on-chain validator only checks the payment credential.
    const ownerAddress = serializeAddressObj(pubKeyAddress(owner), this.networkId);

    const tx = await this.newTxBuilder()
      .spendingPlutusScript(LANGUAGE_VERSION)
      .txIn(
        swapUtxo.input.txHash,
        swapUtxo.input.outputIndex,
        swapUtxo.output.amount,
        swapUtxo.output.address,
      )
      .spendingReferenceTxInInlineDatumPresent()
      // Redeemer `Swap` (Constr 0) — anyone may accept by paying the price.
      .spendingReferenceTxInRedeemerValue(mConStr0([]))
      .txInScript(swapScript)
      // The single payment leg: pays the owner the price, tagged with the swap's
      // tag as a raw bytestring datum so it binds to exactly this swap.
      .txOut(ownerAddress, ensureLovelace(price))
      .txOutInlineDatumValue(tag)
      .changeAddress(walletAddress)
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address,
      )
      .selectUtxosFrom(utxos)
      .complete();

    return tx;
  };

  /**
   * Build a transaction that CANCELS the swap at `swapUtxo`, returning the
   * locked assets to the owner. Called by Person A (the owner); the transaction
   * must be signed by the owner key recorded in the datum. Returns the UNSIGNED
   * transaction hex.
   */
  cancel = async (swapUtxo: UTxO): Promise<string> => {
    const { utxos, walletAddress, collateral } = await this.getWalletInfoForTx();
    const { owner } = this.readTerms(swapUtxo);
    const { swapScript } = this.getScripts();

    const tx = await this.newTxBuilder()
      .spendingPlutusScript(LANGUAGE_VERSION)
      .txIn(
        swapUtxo.input.txHash,
        swapUtxo.input.outputIndex,
        swapUtxo.output.amount,
        swapUtxo.output.address,
      )
      .spendingReferenceTxInInlineDatumPresent()
      // Redeemer `Cancel` (Constr 1) — only the owner, by signing.
      .spendingReferenceTxInRedeemerValue(mConStr1([]))
      .txInScript(swapScript)
      .requiredSignerHash(owner)
      .changeAddress(walletAddress)
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address,
      )
      .selectUtxosFrom(utxos)
      .complete();

    return tx;
  };

  /**
   * Find the swap UTxO produced by a `lock` transaction: the output carrying an
   * inline datum (the one locked at the swap address).
   */
  getSwapUtxo = async (lockTxHash: string): Promise<UTxO | undefined> => {
    const utxos = await this.fetcher.fetchUTxOs(lockTxHash);
    return utxos.find((u) => u.output.plutusData !== undefined);
  };

  /** Sign an unsigned transaction with the wallet and submit it. Returns the tx hash. */
  signAndSubmit = async (unsignedTx: string): Promise<string> => {
    const signedTx = await this.wallet.signTx(unsignedTx);
    return this.submitter.submitTx(signedTx);
  };
}

/** Ensure a payment carries at least the ledger's minimum lovelace. */
function ensureLovelace(price: Asset[]): Asset[] {
  if (price.some((a) => a.unit === "lovelace")) return price;
  return [{ unit: "lovelace", quantity: MIN_PAYMENT_LOVELACE }, ...price];
}
