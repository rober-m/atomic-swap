use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value, add, from_lovelace, quantity_of}
use cardano/transaction.{
  InlineDatum, Output, OutputReference, Transaction, placeholder,
}
use helpers.{
  mock_output, mock_output_marked, mock_output_reference, other_owner,
  test_owner, test_policy_id, test_token_name,
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
//
// Double satisfaction is prevented by requiring the payment leg to carry THIS
// input's own output reference (`own_ref`, the third argument to `spend`) as its
// inline datum. Since every UTxO's output reference is globally unique, no single
// output can settle two swaps at once, and A doesn't have to manage any nonce —
// the ledger guarantees the uniqueness for free.

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
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(SwapDatum { owner, price }) = datum
    when redeemer is {
      // Anyone may consume the UTxO, but the transaction must contain EXACTLY
      // ONE output carrying THIS input's output reference as its inline datum,
      // and that single payment output must go to `owner` and cover the full
      // `price`. Requiring exactly one such output both forces a single payment
      // UTxO and prevents double satisfaction: another swap input has a
      // different output reference, so one output can never settle two swaps.
      Swap -> {
        expect [payment] = list.filter(
          tx.outputs,
          fn(output) { output_marked_with(output, own_ref) },
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

/// True when `output` carries `own_ref` as its inline datum, i.e. the payment is
/// explicitly bound to the swap input being spent.
fn output_marked_with(output: Output, own_ref: OutputReference) -> Bool {
  let expected: Data = own_ref
  when output.datum is {
    InlineDatum(inner) -> inner == expected
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
  Some(SwapDatum { owner: test_owner, price })
}

// A transaction whose only output pays `value` to `recipient`, marked with the
// swap input's output reference `mark`.
fn tx_paying(
  recipient: VerificationKeyHash,
  value: Value,
  mark: OutputReference,
) -> Transaction {
  Transaction {
    ..placeholder,
    outputs: [mock_output_marked(recipient, value, mark)],
  }
}

test success_swap_exact_payment() {
  let own = mock_output_reference(0)
  let tx = tx_paying(test_owner, from_lovelace(10_000_000), own)
  swap.spend(swap_datum(price_10_ada), Swap, own, tx)
}

test success_swap_overpayment() {
  let own = mock_output_reference(0)
  let tx = tx_paying(test_owner, from_lovelace(25_000_000), own)
  swap.spend(swap_datum(price_10_ada), Swap, own, tx)
}

test fail_swap_underpayment() fail {
  let own = mock_output_reference(0)
  let tx = tx_paying(test_owner, from_lovelace(9_999_999), own)
  swap.spend(swap_datum(price_10_ada), Swap, own, tx)
}

test fail_swap_pays_wrong_recipient() fail {
  let own = mock_output_reference(0)
  let tx = tx_paying(other_owner, from_lovelace(10_000_000), own)
  swap.spend(swap_datum(price_10_ada), Swap, own, tx)
}

test success_swap_for_a_token() {
  // Owner wants 5 units of a native token instead of ada.
  let own = mock_output_reference(0)
  let price = [
    PricedAsset { policy: test_policy_id, name: test_token_name, quantity: 5 },
  ]
  let paid = from_lovelace(2_000_000) |> add(test_policy_id, test_token_name, 5)
  let tx = tx_paying(test_owner, paid, own)
  swap.spend(swap_datum(price), Swap, own, tx)
}

test fail_swap_unmarked_payment() fail {
  // A correct payment to the owner that carries NO datum doesn't count — the
  // payment leg must be bound to this swap input's output reference.
  let own = mock_output_reference(0)
  let tx = Transaction {
    ..placeholder,
    outputs: [mock_output(test_owner, from_lovelace(10_000_000))],
  }
  swap.spend(swap_datum(price_10_ada), Swap, own, tx)
}

test fail_swap_payment_marked_for_another_input() fail {
  // The double-satisfaction guard: a payment marked with a DIFFERENT input's
  // reference cannot settle this one, even though it pays the owner enough.
  let own = mock_output_reference(0)
  let tx = tx_paying(
    test_owner,
    from_lovelace(10_000_000),
    mock_output_reference(1),
  )
  swap.spend(swap_datum(price_10_ada), Swap, own, tx)
}

test fail_swap_split_across_two_marked_outputs() fail {
  // Splitting the payment is rejected: exactly one marked output is required.
  let own = mock_output_reference(0)
  let tx = Transaction {
    ..placeholder,
    outputs: [
      mock_output_marked(test_owner, from_lovelace(6_000_000), own),
      mock_output_marked(test_owner, from_lovelace(4_000_000), own),
    ],
  }
  swap.spend(swap_datum(price_10_ada), Swap, own, tx)
}

// Double satisfaction: two swaps to the SAME owner, each asking 10 ADA, are
// spent in ONE transaction that pays the owner only once. Each swap input has a
// distinct output reference, and the single payment can be marked with only one
// of them — so at most one swap's validator can find its payment. The other
// fails, which fails the whole transaction. The attacker cannot take both
// bundles for one payment.
//
// A spend validator runs once per script input, so we model the attack as the
// two separate runs the ledger would perform over the shared transaction.

// The shared transaction: a single payment of 10 ADA to the owner, marked for
// the FIRST swap input (ref 0) only.
fn double_satisfaction_tx() -> Transaction {
  Transaction {
    ..placeholder,
    outputs: [
      mock_output_marked(
        test_owner,
        from_lovelace(10_000_000),
        mock_output_reference(0),
      ),
    ],
  }
}

test double_satisfaction_first_swap_ok() {
  // The swap the single payment is marked for (ref 0) validates.
  swap.spend(
    swap_datum(price_10_ada),
    Swap,
    mock_output_reference(0),
    double_satisfaction_tx(),
  )
}

test fail_double_satisfaction_second_swap() fail {
  // The other swap input (ref 1), sharing that same one-payment transaction, has
  // no output marked for it → its validator fails, so the transaction cannot
  // settle both swaps against a single payment.
  swap.spend(
    swap_datum(price_10_ada),
    Swap,
    mock_output_reference(1),
    double_satisfaction_tx(),
  )
}

test success_cancel_by_owner() {
  let tx = Transaction { ..placeholder, extra_signatories: [test_owner] }
  swap.spend(swap_datum(price_10_ada), Cancel, mock_output_reference(0), tx)
}

test fail_cancel_without_owner_signature() fail {
  let tx = Transaction { ..placeholder, extra_signatories: [other_owner] }
  swap.spend(swap_datum(price_10_ada), Cancel, mock_output_reference(0), tx)
}
