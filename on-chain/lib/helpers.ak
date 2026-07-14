use aiken/crypto.{VerificationKeyHash}
use cardano/address
use cardano/assets.{Value, zero}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference}

pub const test_token_name = "hello world"

pub const test_policy_id =
  #"00000000000000000000000000000000000000000000000000000000"

/// Payment key hash of the swap owner (Person A) used in tests.
pub const test_owner: VerificationKeyHash =
  #"11111111111111111111111111111111111111111111111111111111"

/// A different key hash, used to test payments to the wrong recipient.
pub const other_owner: VerificationKeyHash =
  #"22222222222222222222222222222222222222222222222222222222"

pub fn mock_output_reference(index: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: index,
  }
}

pub fn mock_input(output_reference: OutputReference) -> Input {
  Input {
    output_reference,
    output: Output {
      // A minimal payment address backed by a dummy verification-key hash.
      address: address.from_verification_key(
        #"00000000000000000000000000000000000000000000000000000000",
      ),
      value: zero,
      datum: NoDatum,
      reference_script: None,
    },
  }
}

/// A payment output of `value` sent to the address controlled by `vkh`.
pub fn mock_output(vkh: VerificationKeyHash, value: Value) -> Output {
  Output {
    address: address.from_verification_key(vkh),
    value,
    datum: NoDatum,
    reference_script: None,
  }
}

/// A payment output of `value` to `vkh`, carrying `mark` (a swap input's output
/// reference) as its inline datum.
pub fn mock_output_marked(
  vkh: VerificationKeyHash,
  value: Value,
  mark: OutputReference,
) -> Output {
  Output {
    address: address.from_verification_key(vkh),
    value,
    datum: InlineDatum(mark),
    reference_script: None,
  }
}
