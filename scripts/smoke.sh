#!/usr/bin/env bash
# Post-build smoke test. Runs the built CLI through help + JSON paths and
# verifies the expected output. CI runs this after `npm run build`.

set -euo pipefail

DIST="$(cd "$(dirname "$0")/.."; pwd)/dist/index.js"

run() { node "$DIST" "$@"; }

assert_contains() {
  local needle="$1"; shift
  if ! grep -q -- "$needle" <(echo "$*"); then
    echo "  ✗ expected output to contain: $needle" >&2
    echo "  got: $*" | head -c 500 >&2
    echo >&2
    return 1
  fi
}

assert_not_contains() {
  local needle="$1"; shift
  if grep -q -- "$needle" <(echo "$*"); then
    echo "  ✗ expected output not to contain: $needle" >&2
    echo "  got: $*" | head -c 500 >&2
    echo >&2
    return 1
  fi
}

assert_json_field() {
  local field="$1" expected="$2"; shift 2
  local got
  got=$(echo "$*" | node -e "
    let d = ''; process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      const j = JSON.parse(d);
      const v = '$field'.split('.').reduce((acc, k) => acc?.[k], j);
      process.stdout.write(String(v));
    });
  ")
  if [ "$got" != "$expected" ]; then
    echo "  ✗ JSON .$field expected '$expected', got '$got'" >&2
    return 1
  fi
}

echo "smoke: zkr --version"
out=$(run --version)
[ "$out" = "2.0.0" ] || { echo "  ✗ version mismatch: '$out'" >&2; exit 1; }
echo "  ✓ 2.0.0"

echo "smoke: zkr --help"
out=$(run --help)
assert_contains "wallet" "$out"
assert_contains "pools" "$out"
assert_contains "deposit" "$out"
assert_contains "withdraw" "$out"
assert_not_contains "recovery" "$out"
echo "  ✓ all top-level commands present"

echo "smoke: zkr wallet --help"
out=$(run wallet --help)
assert_contains "new" "$out"
assert_contains "import" "$out"
assert_contains "list" "$out"
assert_contains "show" "$out"
assert_contains "remove" "$out"
assert_contains "export-mnemonic" "$out"
assert_contains "sign" "$out"
echo "  ✓ wallet subcommands present (new/import/list/show/remove/export-mnemonic/sign)"

echo "smoke: zkr pools --help"
out=$(run pools --help)
assert_contains "list" "$out"
assert_contains "info" "$out"
echo "  ✓ pools subcommands present"

echo "smoke: zkr pool --help"
out=$(run pool --help)
assert_contains "create" "$out"
assert_contains "create-ton" "$out"
assert_contains "activate" "$out"
echo "  ✓ pool subcommands present (create/create-ton/activate)"

echo "smoke: removed recovery command stays unavailable"
set +e
out=$(run recovery --json 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] || { echo "  ✗ removed recovery command unexpectedly succeeded" >&2; exit 1; }
assert_json_field "success" "false" "$out"
assert_contains 'Unknown command `recovery`' "$out"
echo "  ✓ removed recovery command is rejected"

# JSON error envelope check (no network needed — wallet not found returns CliError)
echo "smoke: zkr wallet show <nonexistent> --json"
# Force a temp HOME so we don't accidentally read a real wallet.
TMP=$(mktemp -d)
HOME="$TMP" out=$(run wallet show __nonexistent_test_wallet__ --json 2>&1 || true)
assert_json_field "success" "false" "$out"
assert_json_field "error" "WALLET_NOT_FOUND" "$out"
echo "  ✓ structured error envelope works"

echo
echo "all smoke checks passed."
