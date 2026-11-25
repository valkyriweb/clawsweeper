#!/usr/bin/env bash
# One-command check for the ClawSweeper PR automerge gate model.
# Usage: formal/pr-automerge-gate/check.sh [--no-build] [--out DIR]
# Exit 0: the model's broken invariants equal expected-violations.txt.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
build=1
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) build=0 ;;
    --out) out="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
out="${out:-$(mktemp -d "${TMPDIR:-/tmp}/pr-automerge-gate.XXXXXX")}"
mkdir -p "$out"

tlc_version="1.7.4"
tlc_sha256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
jar="${TLA2TOOLS:-$HOME/.cache/clawsweeper-formal/tla2tools-$tlc_version.jar}"
java_bin="${JAVA:-java}"
if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  gh release download "v$tlc_version" --repo tlaplus/tlaplus --pattern tla2tools.jar \
    --output "$jar" 2>/dev/null ||
    curl -fsSL -o "$jar" \
      "https://github.com/tlaplus/tlaplus/releases/download/v$tlc_version/tla2tools.jar"
fi
actual_sha="$(shasum -a 256 "$jar" | cut -d' ' -f1)"
if [ "$actual_sha" != "$tlc_sha256" ]; then
  echo "tla2tools.jar checksum mismatch: $actual_sha (want $tlc_sha256)" >&2
  exit 2
fi

if [ "$build" = 1 ]; then
  (cd "$root" && pnpm run --silent build:repair >/dev/null)
fi

cp "$here/PrAutomergeGate.tla" "$out/"
node "$here/derive-guards.mjs" >"$out/PrAutomergeGate.cfg"
sed 's/^    MergedCommitWasReviewed$/    NeverMerged/; /^    NoMergeOverFailVerdict$/d' \
  "$out/PrAutomergeGate.cfg" >"$out/Sanity.cfg"

run_tlc() {
  local name="${1%.cfg}"
  (cd "$out" && "$java_bin" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -continue \
    -config "$1" -metadir "$out/states-$name" PrAutomergeGate.tla >"$out/$name.out" 2>&1) || true
  grep -oE 'Invariant [A-Za-z]+ is violated' "$out/$name.out" | awk '{print $2}' | sort -u
}

sanity="$(run_tlc Sanity.cfg)"
if [ "$sanity" != "NeverMerged" ]; then
  echo "SANITY FAILED: no merge is reachable, so the rules pass vacuously. See $out/Sanity.out" >&2
  exit 1
fi

broken="$(run_tlc PrAutomergeGate.cfg)"
if ! grep -q 'Model checking completed' "$out/PrAutomergeGate.out"; then
  echo "TLC did not finish. See $out/PrAutomergeGate.out" >&2
  exit 2
fi
expected="$(grep -vE '^[[:space:]]*(#|$)' "$here/expected-violations.txt" | sort -u)"
grep -E 'states generated' "$out/PrAutomergeGate.out" | tail -1
echo "broken:   $(echo ${broken:-none} | tr '\n' ' ')"
echo "expected: $(echo ${expected:-none} | tr '\n' ' ')"
echo "TLC output: $out/PrAutomergeGate.out"
if [ "$broken" != "$expected" ]; then
  new="$(comm -23 <(echo "$broken") <(echo "$expected"))"
  gone="$(comm -13 <(echo "$broken") <(echo "$expected"))"
  if [ -n "$new" ]; then echo "NEW VIOLATION: $new" >&2; fi
  if [ -n "$gone" ]; then echo "NOW HOLDS (update expected-violations.txt after review): $gone" >&2; fi
  exit 1
fi
echo "OK: only the known findings break."
