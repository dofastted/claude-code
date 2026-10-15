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
