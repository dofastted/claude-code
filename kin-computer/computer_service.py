#!/usr/bin/env python3
# Closed computer-creation entry. vm2api calls the compiled binary, not this file.
"""Create one slot computer. The algorithm stays inside the binary."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def _os_root() -> Path:
    return Path(os.environ.get("KIN_VM_OS_ROOT", "/mnt/d/vm-os"))


def _asset(name: str) -> Path:
    here = Path(__file__).resolve().parent
    os_root = _os_root()
    for candidate in (
        here / name,
        here / "docker" / "kin-os" / name,
        os_root / name,
        os_root / "docker" / "kin-os" / name,
    ):
        if candidate.is_file():
            return candidate
    raise SystemExit(f"computer service is missing bundled file {name}")


def _write_system(persona_path: Path, system_root: Path) -> dict[str, str]:
    from fingerprint_apple import hardware_tree, independent_computer

    cfg = json.loads(persona_path.read_text(encoding="utf-8"))
    product = str(cfg.get("model_identifier") or cfg.get("hostname") or "mac")
    comp = independent_computer(
        product,
        str(cfg.get("hardware_uuid") or ""),
        str(cfg.get("en0_mac") or cfg.get("hostname") or "persona"),
    )
    name = comp["hostname"]
    machine_id = comp["machine_id"]
    etc = system_root / "etc"
    etc.mkdir(parents=True, exist_ok=True)
    (etc / "hostname").write_text(name + "\n", encoding="utf-8")
    (etc / "machine-id").write_text(machine_id + "\n", encoding="utf-8")
    dbus = system_root / "var" / "lib" / "dbus"
    dbus.mkdir(parents=True, exist_ok=True)
    dbus_id = dbus / "machine-id"
    if not dbus_id.is_symlink():
        dbus_id.write_text(machine_id + "\n", encoding="utf-8")
    hosts = etc / "hosts"
    lines = hosts.read_text(encoding="utf-8").splitlines() if hosts.is_file() else []
    lines = [line for line in lines if not line.startswith("127.0.1.1 ")]
    if not any(line.startswith("127.0.0.1 ") for line in lines):
        lines.insert(0, "127.0.0.1 localhost")
    lines.append(f"127.0.1.1 {name}")
    hosts.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tree = hardware_tree(cfg)
    for rel, body in tree.items():
        dest = system_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        text = body if str(body).endswith("\n") else str(body) + "\n"
        dest.write_text(text, encoding="utf-8")
    summary = [f"hostname={name}", f"machine_id={machine_id}"]
    for rel, body in tree.items():
        if rel.endswith(".json"):
            continue
        summary.append(f"{rel.split('/', 1)[-1]}={str(body).rstrip()}")
    summary.extend(["source=macos-persona", ""])
    (etc / "kin-computer").write_text("\n".join(summary), encoding="utf-8")
    mac = ""
    mac_file = system_root / "hardware" / "mac"
    if mac_file.is_file():
        mac = "".join(mac_file.read_text(encoding="utf-8").split()).lower()
    return {"hostname": name, "machine_id": machine_id, "mac": mac}


def _install_persona(out: Path) -> None:
    ready = out / "persona" / "usr" / "local" / "bin" / "sw_vers"
    if ready.is_file() and os.access(ready, os.X_OK):
        return
    script = _asset("install_macos_persona.sh")
    env = os.environ.copy()
    env["MOCK_PREFIX_DIR"] = str(out / "persona")
    env["PERSONA_JSON"] = str(out / "macos_persona.json")
    completed = subprocess.run(["bash", str(script)], env=env, check=False, capture_output=True, text=True)
    if completed.returncode:
        sys.stderr.write(completed.stderr or completed.stdout)
        raise SystemExit(f"persona installer failed: {completed.returncode}")


def _profiles():
    from kvm_fingerprint_engine import UniversalFingerprintIngestor

    return UniversalFingerprintIngestor.load_all_profiles()


def create_linux(vm_id: str, out: Path) -> dict[str, str]:
    from fingerprint_apple import build_pc_fingerprint, choose_profile, write_pc_fingerprint

    profiles = _profiles()
    pc = [prof for prof in profiles if "apple" not in prof.system.get("Manufacturer", "").lower()] or profiles
    chosen = choose_profile(pc, "vm-id", vm_id)
    res = build_pc_fingerprint(chosen, vm_id, "linux")
    out.mkdir(parents=True, exist_ok=True)
    write_pc_fingerprint(res, str(out))
    return {"hostname": res["hostname"], "machine_id": res["machine_id"], "mac": ""}


def create_docker(vm_id: str, out: Path) -> dict[str, str]:
    from fingerprint_apple import choose_profile, write_container_persona
    from kvm_fingerprint_engine import build_macos_vm_from_bsdhw

    profiles = _profiles()
    chosen = choose_profile(profiles, "vm-id", vm_id)
    res = build_macos_vm_from_bsdhw(prof=chosen, vm_id=vm_id)
    out.mkdir(parents=True, exist_ok=True)
    write_container_persona(res, str(out))
    _install_persona(out)
    return _write_system(out / "macos_persona.json", out / "system")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create one closed-source slot computer")
    sub = parser.add_subparsers(dest="cmd", required=True)
    create = sub.add_parser("create")
    create.add_argument("--runtime", choices=["docker", "kvm"], required=True)
    create.add_argument("--vm-id", required=True)
    create.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    if args.runtime == "kvm":
        result = create_linux(args.vm_id, out)
    else:
        result = create_docker(args.vm_id, out)
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
