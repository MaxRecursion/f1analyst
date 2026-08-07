#!/usr/bin/env bash
# Arm B, step 1 — acquire the toolchain needed to statically link DuckDB into a
# .NET 10 Blazor WASM app.
#
# .NET 10's WebAssembly build tools pin Emscripten 3.1.56, and Microsoft documents
# that prebuilt native dependencies "typically must be built using the same version of
# Emscripten used to build the .NET WebAssembly runtime". So DuckDB must be compiled
# with exactly 3.1.56 for NativeFileReference to link it.
#
# For reference, duckdb-wasm itself does NOT use 3.1.56:
#   coi variant   -> 3.1.57  (pinned back for pthreads compatibility)
#   other variants-> 3.1.71
# We are therefore attempting a combination nobody upstream builds or tests.
# That is the point of the experiment.
#
# Everything installs under demo/.toolchain/ — nothing touches the system.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TC="$ROOT/.toolchain"
EMSDK_VERSION="3.1.56"
DUCKDB_TAG="v1.4.3"        # matches the DuckDB core behind duckdb-wasm 1.32.0

mkdir -p "$TC"
cd "$TC"

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
ok()   { printf '  [ok]   %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; }

step "1/4  build tools (cmake, ninja) via pip --user"
if ! command -v cmake >/dev/null 2>&1; then
  python3 -m pip install --user --quiet cmake ninja 2>&1 | tail -3 \
    || python3 -m pip install --user --quiet --break-system-packages cmake ninja 2>&1 | tail -3
fi
# pip --user scripts land here on macOS framework python
export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"

# emsdk requires Python >= 3.10; macOS system python is 3.9.6. Homebrew's
# python@3.12 libexec/bin exposes a plain `python3` that shadows the system one.
for P in /opt/homebrew/opt/python@3.12/libexec/bin /usr/local/opt/python@3.12/libexec/bin; do
  [ -x "$P/python3" ] && export PATH="$P:$PATH" && break
done
PYV="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"
case "$PYV" in
  3.9|3.8|"") fail "python3 is $PYV — emsdk needs >= 3.10"; exit 1 ;;
  *) ok "python3 $PYV" ;;
esac
command -v cmake >/dev/null 2>&1 && ok "cmake $(cmake --version | head -1)" || { fail "cmake unavailable"; exit 1; }
command -v ninja >/dev/null 2>&1 && ok "ninja $(ninja --version)" || fail "ninja unavailable (will fall back to make)"

step "2/4  emsdk $EMSDK_VERSION"
if [ ! -d emsdk ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git 2>&1 | tail -2 || { fail "emsdk clone"; exit 1; }
fi
cd emsdk
./emsdk install "$EMSDK_VERSION" 2>&1 | tail -5 || { fail "emsdk install $EMSDK_VERSION"; exit 1; }
./emsdk activate "$EMSDK_VERSION" 2>&1 | tail -3 || { fail "emsdk activate"; exit 1; }
# shellcheck disable=SC1091
source ./emsdk_env.sh >/dev/null 2>&1
ok "emcc $(emcc --version | head -1)"
cd "$TC"

step "3/4  duckdb $DUCKDB_TAG source"
if [ ! -d duckdb ]; then
  git clone --depth 1 --branch "$DUCKDB_TAG" https://github.com/duckdb/duckdb.git 2>&1 | tail -2 \
    || { fail "duckdb clone"; exit 1; }
fi
ok "duckdb source at $(du -sh duckdb | cut -f1)"

step "4/4  summary"
cat <<EOF
  emsdk    : $TC/emsdk        ($EMSDK_VERSION)
  duckdb   : $TC/duckdb       ($DUCKDB_TAG)
  next     : tools/build-duckdb-static.sh   (the actual cross-compile)

  To use the toolchain in a new shell:
    source "$TC/emsdk/emsdk_env.sh"
    export PATH="\$HOME/Library/Python/3.9/bin:\$PATH"
EOF
