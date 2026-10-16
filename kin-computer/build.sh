#!/bin/sh
# Compile the closed computer service. Algorithm sources stay in the vm-os tree.
# Output is local-src/kin-computer/dist/kin-computer and is not committed.
set -eu
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
os=${KIN_VM_OS_ROOT:-/mnt/d/vm-os}
py=${KIN_COMPUTER_PYTHON:-python3}
if [ ! -f "$os/fingerprint_apple.py" ] || [ ! -f "$os/kvm_fingerprint_engine.py" ]; then
  echo "kin-computer: algorithm sources missing under $os" >&2
  exit 1
fi
# Match the oldest control-plane runtime, not the build host's newer glibc.
if [ "${KIN_COMPUTER_IN_CONTAINER:-}" != 1 ]; then
  mkdir -p "$here/dist"
  exec docker run --rm \
    --mount "type=bind,src=$here,dst=/src,readonly" \
    --mount "type=bind,src=$here/dist,dst=/src/dist" \
    --mount "type=bind,src=$os,dst=/vm-os,readonly" \
    node:22-bookworm-slim bash -c '
      set -eu
      apt-get update
      apt-get install -y --no-install-recommends python3-dev python3-venv gcc g++ patchelf
      python3 -m venv /tmp/build-env
      /tmp/build-env/bin/pip install Nuitka zstandard ordered-set
      KIN_COMPUTER_IN_CONTAINER=1 KIN_VM_OS_ROOT=/vm-os \
        KIN_COMPUTER_PYTHON=/tmp/build-env/bin/python sh /src/build.sh
    '
fi
if ! "$py" -m nuitka --version >/dev/null 2>&1; then
  echo "kin-computer: nuitka is not available to $py" >&2
  exit 1
fi
mkdir -p "$here/dist"
export PYTHONPATH="$os${PYTHONPATH:+:$PYTHONPATH}"
"$py" -m nuitka \
  --onefile \
  --output-dir="$here/dist" \
  --output-filename=kin-computer \
  --include-module=fingerprint_apple \
  --include-module=kvm_fingerprint_engine \
  --include-data-files="$os/install_macos_persona.sh=install_macos_persona.sh" \
  "$here/computer_service.py"
rm -rf "$here/dist/computer_service.build" \
  "$here/dist/computer_service.dist" \
  "$here/dist/computer_service.onefile-build"
echo "kin-computer: $here/dist/kin-computer"
