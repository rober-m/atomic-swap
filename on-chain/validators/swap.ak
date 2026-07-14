use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value, add, from_lovelace, quantity_of}
use cardano/transaction.{
  InlineDatum, Output, OutputReference, Transaction, placeholder,
}
use helpers.{
  mock_output_reference, mock_output_tagged, other_owner, test_owner,
  test_policy_id, test_tag, test_token_name,
}

// A simple atomic-swap spending validator.
//
// Person A locks some assets at this script address and, in the datum, states
// the `owner` (A's payment key hash) and the `price` (the assets A wants in
// return). The locked UTxO can then be consumed by ANYONE (Person B) as long as
// the spending transaction pays the `owner` at least the `price`. B keeps the
// locked assets; A receives the price. This is atomic: both parties settle in the
// same transaction or neither does.
//
// A can also reclaim the locked assets at any time (a `Cancel`) by signing the
// transaction, so funds are never stuck if no counterparty shows up.

/// A single asset the owner is asking for. Ada is represented with an empty
/// policy id and empty asset name (see `assets.ada_policy_id`).
pub type PricedAsset {
  policy: PolicyId,
  name: AssetName,
  quantity: Int,
}

/// Inline datum attached to the locked UTxO. Set by Person A when locking.
pub type SwapDatum {
  /// Payment key hash of the person who must be paid (Person A).
  owner: VerificationKeyHash,
  /// The minimum assets that must be paid to `owner` to take the locked value.
  price: List<PricedAsset>,
  /// A unique tag identifying this swap. The payment must carry this exact
  /// tag as its inline datum, which binds the payment to this specific swap and
  /// prevents one payment output from satisfying several swaps at once (the
  /// "double satisfaction" attack). Person A must pick a value unique across
  /// their live swaps. Deriving it from the seed UTxO's output reference (which
  /// is globally unique) is the natural choice.
  tag: ByteArray,
}

/// Spending redeemer: either swap (anyone pays the price) or cancel (owner
/// reclaims).
pub type SwapAction {
  Swap
  Cancel
}

validator swap {
  spend(
    datum: Option<SwapDatum>,
    redeemer: SwapAction,
    _own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(SwapDatum { owner, price, tag }) = datum
    when redeemer is {
      // Anyone may consume the UTxO, but the transaction must contain EXACTLY
      // ONE output carrying this swap's `tag` as its inline datum, and that
      // single payment output must go to `owner` and cover the full `price`.
      // Requiring exactly one tagged output both forces a single payment UTxO
      // and prevents double satisfaction: a different swap carries a different
      // tag, so one output can never settle two swaps.
      Swap -> {
        expect [payment] = list.filter(
          tx.outputs,
          fn(output) { output_tagged_with(output, tag) },
        )
        and {
          paid_to(payment, owner),
          list.all(
            price,
            fn(item) {
              quantity_of(payment.value, item.policy, item.name) >= item.quantity
            },
          ),
        }
      }
      // The owner can always reclaim their locked assets by signing.
      Cancel -> list.has(tx.extra_signatories, owner)
    }
  }

  else(_) {
    fail
  }
}

/// True when `output` carries `tag` as its inline datum (a raw `ByteArray`).
fn output_tagged_with(output: Output, tag: ByteArray) -> Bool {
  when output.datum is {
    InlineDatum(inner) ->
      if inner is bytes: ByteArray {
        bytes == tag
      } else {
        False
      }
    _ -> False
  }
}

/// True when `output`'s payment credential is `owner`'s verification-key hash.
fn paid_to(output: Output, owner: VerificationKeyHash) -> Bool {
  when output.address.payment_credential is {
    VerificationKey(vkh) -> vkh == owner
    _ -> False
  }
}

// --------------------------------- TESTS --------------------------------------
// ------------------------------------------------------------------------------

// Owner asks for 10 ADA in return for whatever is locked.
const price_10_ada: List<PricedAsset> =
  [PricedAsset { policy: "", name: "", quantity: 10_000_000 }]

fn swap_datum(price: List<PricedAsset>) -> Option<SwapDatum> {
  Some(SwapDatum { owner: test_owner, price, tag: test_tag })
}

// A transaction whose only output pays `value` to `recipient`, tagged `tag`.
fn tx_paying(
  recipient: VerificationKeyHash,
  value: Value,
  tag: ByteArray,
) -> Transaction {
  Transaction {
    ..placeholder,
    outputs: [mock_output_tagged(recipient, value, tag)],
  }
}

test success_swap_exact_payment() {
  let tx = tx_paying(test_owner, from_lovelace(10_000_000), test_tag)
  swap.spend(swap_datum(price_10_ada), Swap, mock_output_reference(0), tx)
}

test success_swap_overpayment() {
  let tx = tx_paying(test_owner, from_lovelace(25_000_000), test_tag)
  swap.spend(swap_datum(price_10_ada), Swap, mock_output_reference(0), tx)
}

test fail_swap_underpayment() fail {
  let tx = tx_paying(test_owner, from_lovelace(9_999_999), test_tag)
  swap.spend(swap_datum(price_10_ada), Swap, mock_output_reference(0), tx)
}

test fail_swap_pays_wrong_recipient() fail {
  let tx = tx_paying(other_owner, from_lovelace(10_000_000), test_tag)
  swap.spend(swap_datum(price_10_ada), Swap, mock_output_reference(0), tx)
}

test success_swap_for_a_token() {
  // Owner wants 5 units of a native token instead of ada.
  let price = [
    PricedAsset { policy: test_policy_id, name: test_token_name, quantity: 5 },
  ]
  let paid = from_lovelace(2_000_000) |> add(test_policy_id, test_token_name, 5)
  let tx = tx_paying(test_owner, paid, test_tag)
  swap.spend(swap_datum(price), Swap, mock_output_reference(0), tx)
}

test fail_swap_untagged_payment() fail {
  // A correct payment to the owner that carries NO tag doesn't count — the
  // payment leg must be bound to this swap.
  let tx = Transaction {
    ..placeholder,
    outputs: [mock_output_tagged(test_owner, from_lovelace(10_000_000), "")],
  }
  swap.spend(swap_datum(price_10_ada), Swap, mock_output_reference(0), tx)
}

test fail_swap_payment_tagged_for_another_swap() fail {
  // The double-satisfaction guard: a payment tagged for a DIFFERENT swap
  // cannot settle this one, even though it pays the owner enough.
  let tx = tx_paying(test_owner, from_lovelace(10_000_000), #"cafe")
  swap.spend(swap_datum(price_10_ada), Swap, mock_output_reference(0), tx)
}

test fail_swap_split_across_two_tagged_outputs() fail {
  // Splitting the payment is rejected: exactly one tagged output is required.
  let tx = Transaction {
    ..placeholder,
    outputs: [
      mock_output_tagged(test_owner, from_lovelace(6_000_000), test_tag),
      mock_output_tagged(test_owner, from_lovelace(4_000_000), test_tag),
    ],
  }
  swap.spend(swap_datum(price_10_ada), Swap, mock_output_reference(0), tx)
}

test success_cancel_by_owner() {
  let tx = Transaction { ..placeholder, extra_signatories: [test_owner] }
  swap.spend(swap_datum(price_10_ada), Cancel, mock_output_reference(0), tx)
}

test fail_cancel_without_owner_signature() fail {
  let tx = Transaction { ..placeholder, extra_signatories: [other_owner] }
  swap.spend(swap_datum(price_10_ada), Cancel, mock_output_reference(0), tx)
}
