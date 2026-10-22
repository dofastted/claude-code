#!/usr/bin/env python3
# Closed computer-creation entry. vm2api calls the compiled binary, not this file.
"""Create one slot computer. The algorithm stays inside the binary."""

from __future__ import annotations

import argparse
import hashlib
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


# Apple-only identity files; a Linux PC has no SMC, ROM or MLB.
_APPLE_ONLY = ("hardware/smc_version", "hardware/rom", "hardware/mlb")


def _write_system(system_root: Path, name: str, machine_id: str, tree: dict[str, str], source: str) -> dict[str, str]:
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
    summary.extend([f"source={source}", ""])
    (etc / "kin-computer").write_text("\n".join(summary), encoding="utf-8")
    mac = ""
    mac_file = system_root / "hardware" / "mac"
    if mac_file.is_file():
        mac = "".join(mac_file.read_text(encoding="utf-8").split()).lower()
    return {"hostname": name, "machine_id": machine_id, "mac": mac}


def _container_mac(vm_id: str, uuid: str) -> str:
    """Stable locally administered unicast. Profile DMI carries no NIC MAC."""
    raw = bytearray(hashlib.sha256(f"container-mac|{vm_id}|{uuid}".encode("utf-8")).digest()[:6])
    raw[0] = (raw[0] & 0xFC) | 0x02
    return ":".join(f"{byte:02x}" for byte in raw)


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


def _pc_profile(vm_id: str):
    from fingerprint_apple import choose_profile

    profiles = _profiles()
    pc = [prof for prof in profiles if "apple" not in prof.system.get("Manufacturer", "").lower()] or profiles
    return choose_profile(pc, "vm-id", vm_id)


def create_pc_kvm(vm_id: str, out: Path, guest_os: str) -> dict[str, str]:
    from fingerprint_apple import build_pc_fingerprint, write_pc_fingerprint

    res = build_pc_fingerprint(_pc_profile(vm_id), vm_id, guest_os)
    out.mkdir(parents=True, exist_ok=True)
    write_pc_fingerprint(res, str(out))
    return {"hostname": res["hostname"], "machine_id": res["machine_id"], "mac": ""}


def create_pc_container(vm_id: str, out: Path, guest_os: str) -> dict[str, str]:
    """Linux/Windows PC for a container slot: same profile pick and published-DMI rule as KVM."""
    from fingerprint_apple import _published, build_pc_fingerprint, hardware_tree

    chosen = _pc_profile(vm_id)
    res = build_pc_fingerprint(chosen, vm_id, guest_os)
    hw = res["hardware"]
    hw["en0_mac"] = _container_mac(vm_id, res["uuid"])
    hw["physical_cores"] = chosen.processor.get("core_count_num") or ""
    ram_mb = hw.get("ram_mb")
    if isinstance(ram_mb, int) and ram_mb > 0:
        hw["ram_gb"] = ram_mb // 1024
        hw["ram_bytes"] = ram_mb * 1024 * 1024
    tree = {rel: body for rel, body in hardware_tree(hw).items() if rel not in _APPLE_ONLY}
    # Linux sysfs prints the SMBIOS UUID in lower case; Windows keeps the firmware case.
    uuid = res["uuid"] or ""
    tree["dmi/id/product_uuid"] = uuid.lower() if guest_os == "linux" else uuid
    tree["dmi/id/product_version"] = _published(chosen.system.get("Version")) or ""
    out.mkdir(parents=True, exist_ok=True)
    (out / "pc_identity.json").write_text(json.dumps(res, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return _write_system(out / "system", res["hostname"], res["machine_id"], tree, f"{guest_os}-pc")


def create_macos_container(vm_id: str, out: Path) -> dict[str, str]:
    from fingerprint_apple import choose_profile, hardware_tree, independent_computer, write_container_persona
    from kvm_fingerprint_engine import build_macos_vm_from_bsdhw

    profiles = _profiles()
    chosen = choose_profile(profiles, "vm-id", vm_id)
    res = build_macos_vm_from_bsdhw(prof=chosen, vm_id=vm_id)
    out.mkdir(parents=True, exist_ok=True)
    write_container_persona(res, str(out))
    _install_persona(out)
    cfg = json.loads((out / "macos_persona.json").read_text(encoding="utf-8"))
    product = str(cfg.get("model_identifier") or cfg.get("hostname") or "mac")
    comp = independent_computer(
        product,
        str(cfg.get("hardware_uuid") or ""),
        str(cfg.get("en0_mac") or cfg.get("hostname") or "persona"),
    )
    return _write_system(out / "system", comp["hostname"], comp["machine_id"], hardware_tree(cfg), "macos-persona")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create one closed-source slot computer")
    sub = parser.add_subparsers(dest="cmd", required=True)
    create = sub.add_parser("create")
    create.add_argument("--runtime", choices=["docker", "kvm"], required=True)
    create.add_argument("--vm-id", required=True)
    create.add_argument("--out", required=True)
    create.add_argument("--os", choices=["linux", "windows", "macos"], default="linux")
    args = parser.parse_args()
    out = Path(args.out)
    if args.runtime == "kvm":
        if args.os == "macos":
            parser.error("kvm computers are linux or windows")
        result = create_pc_kvm(args.vm_id, out, args.os)
    elif args.os == "macos":
        result = create_macos_container(args.vm_id, out)
    else:
        result = create_pc_container(args.vm_id, out, args.os)
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
