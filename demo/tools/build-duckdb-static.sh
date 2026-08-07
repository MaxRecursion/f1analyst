#!/usr/bin/env bash
# Arm B, step 2 — cross-compile DuckDB v1.4.3 to a static wasm library with the exact
# Emscripten that .NET 10 pins (3.1.56), so it can be fed to NativeFileReference and
# called by P/Invoke from a Blazor WebAssembly app.
#
# This is a genuine experiment, not a formality. Nobody upstream builds this
# combination: duckdb-wasm itself uses emsdk 3.1.57 (coi) / 3.1.71 (others), never
# 3.1.56. Record every failure faithfully — a failure here IS the demo result.
#
# Choices and why:
#   DISABLE_THREADS=1, USE_WASM_THREADS=0
#       .NET's Blazor WASM runtime is single-threaded, so DuckDB must be too. A
#       -pthread build would demand shared memory the .NET module does not declare.
#   BUILD_EXTENSIONS="parquet"
#       Under EMSCRIPTEN duckdb builds extensions as STATIC libs. Linking parquet in
#       avoids the runtime fetch from extensions.duckdb.org that broke our earlier
#       spike — and an offline-required app cannot fetch extensions anyway.
#   -fwasm-exceptions
#       .NET 8+ builds with native wasm exception handling (WasmEnableExceptionHandling
#       defaults true). DuckDB is C++ and needs exceptions; both objects must agree on
#       the EH scheme or they will not link.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TC="$ROOT/.toolchain"
SRC="$TC/duckdb"
BUILD="$TC/duckdb-build-wasm"
OUT="$ROOT/artifacts/duckdb-wasm-static"
LOG="$TC/build-duckdb-static.log"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

export PATH="$HOME/Library/Python/3.9/bin:$PATH"
for P in /opt/homebrew/opt/python@3.12/libexec/bin /usr/local/opt/python@3.12/libexec/bin; do
  [ -x "$P/python3" ] && export PATH="$P:$PATH" && break
done
# shellcheck disable=SC1091
source "$TC/emsdk/emsdk_env.sh" >/dev/null 2>&1 || { echo "emsdk not prepared — run prep-duckdb-wasm-toolchain.sh"; exit 1; }

mkdir -p "$OUT"
: > "$LOG"

banner() { printf '\n\033[1m=== %s ===\033[0m\n' "$1" | tee -a "$LOG"; }

banner "toolchain"
{ emcc --version | head -1; cmake --version | head -1; } | tee -a "$LOG"

banner "configure"
# Cache clean when the configure step itself is what we're testing.
rm -rf "$BUILD"
emcmake cmake -S "$SRC" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHELL=0 \
  -DBUILD_UNITTESTS=0 \
  -DBUILD_BENCHMARKS=0 \
  -DBUILD_JEMALLOC=0 \
  -DBUILD_EXTENSIONS="parquet" \
  -DDISABLE_THREADS=1 \
  -DUSE_WASM_THREADS=0 \
  -DENABLE_EXTENSION_AUTOLOADING=0 \
  -DENABLE_EXTENSION_AUTOINSTALL=0 \
  -DCMAKE_CXX_FLAGS="-fwasm-exceptions -O2" \
  -DCMAKE_C_FLAGS="-fwasm-exceptions -O2" \
  2>&1 | tee -a "$LOG"

CONFIGURE_RC=${PIPESTATUS[0]}
if [ "$CONFIGURE_RC" -ne 0 ]; then
  banner "RESULT: CONFIGURE FAILED (rc=$CONFIGURE_RC)"
  echo "This is a demo result, not a setup problem. See $LOG" | tee -a "$LOG"
  exit "$CONFIGURE_RC"
fi

banner "compile (this is the long part — ~500k LOC of C++ on $JOBS cores)"
START=$(date +%s)
cmake --build "$BUILD" --target duckdb_static -j "$JOBS" 2>&1 | tee -a "$LOG"
BUILD_RC=${PIPESTATUS[0]}
ELAPSED=$(( $(date +%s) - START ))

if [ "$BUILD_RC" -ne 0 ]; then
  banner "RESULT: COMPILE FAILED after ${ELAPSED}s (rc=$BUILD_RC)"
  echo "First errors:" | tee -a "$LOG"
  grep -n "error:" "$LOG" | head -20 | tee -a "$LOG"
  exit "$BUILD_RC"
fi

banner "collect artifacts"
find "$BUILD" -name '*.a' -exec cp {} "$OUT/" \; 2>/dev/null
cp "$SRC/src/include/duckdb.h" "$OUT/" 2>/dev/null
ls -la "$OUT" | tee -a "$LOG"
TOTAL=$(find "$OUT" -name '*.a' -exec stat -f%z {} \; 2>/dev/null | awk '{s+=$1} END {printf "%.1f", s/1048576}')

banner "RESULT: BUILD SUCCEEDED in ${ELAPSED}s — ${TOTAL} MB of static libs"
cat <<EOF | tee -a "$LOG"
  Next: reference these from the Blazor WASM csproj as
      <NativeFileReference Include="artifacts/duckdb-wasm-static/libduckdb_static.a" />
  and P/Invoke against duckdb.h.

  Still unproven at this point:
    - whether .NET's runtime relinking accepts a library this size
    - whether the EH scheme actually matches at link time
    - whether DuckDB's synchronous filesystem can reach anything from the main thread
EOF
