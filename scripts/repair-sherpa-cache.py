#!/usr/bin/env python3
"""Repair incomplete sherpa-onnx-sys prebuilt extractions after rust-cache restore.

Pinned sherpa-onnx-sys 1.12.40 trusts lib_dir.is_dir(), even when cached native
libraries were removed. Preserve healthy extractions and downloaded archives;
only invalidate this Cargo package when a recognized extraction is incomplete.
The caller supplies the SAME resolved target directory used for its Cargo run.
"""

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

STATIC_LIBS = (
    "sherpa-onnx-c-api", "sherpa-onnx-core", "kaldi-decoder-core",
    "sherpa-onnx-kaldifst-core", "sherpa-onnx-fstfar", "sherpa-onnx-fst",
    "kaldi-native-fbank-core", "kissfft-float", "piper_phonemize", "espeak-ng",
    "ucd", "onnxruntime", "ssentencepiece_core",
)


def repair(target_dir):
    if os.environ.get("SHERPA_ONNX_LIB_DIR") is not None:
        # Explicit native libraries are caller-owned, not our download cache.
        return
    cache = target_dir / "sherpa-onnx-prebuilt"
    if cache.is_symlink():
        raise RuntimeError("Refusing to repair a symlinked Sherpa cache")
    if not cache.is_dir():
        return
    # Limit repair to the locked version, whose link list this helper knows.
    manifest = Path(__file__).resolve().parent.parent / "src-tauri/Cargo.toml"
    lock = manifest.with_name("Cargo.lock").read_text()
    package = re.search(r'\[\[package\]\]\nname = "sherpa-onnx-sys"\nversion = "([^"]+)"', lock)
    if not package or package[1] != "1.12.40":
        raise RuntimeError("Review Sherpa cache repair requirements for the locked sys version")
    pattern = re.compile(r"sherpa-onnx-v1\.12\.40-(linux|osx)-(?:x64|aarch64|arm64)-(static|shared)(?:-cpu)?-lib")
    broken = []
    for extraction in cache.iterdir():
        match = pattern.fullmatch(extraction.name)
        if not match:
            continue
        if extraction.is_symlink():
            raise RuntimeError("Refusing to repair a symlinked Sherpa extraction")
        if not extraction.is_dir():
            continue
        extension = ".a" if match[2] == "static" else ".dylib" if match[1] == "osx" else ".so"
        names = STATIC_LIBS if match[2] == "static" else ("sherpa-onnx-c-api", "onnxruntime")
        libraries = [extraction / "lib" / ("lib" + name + extension) for name in names]
        if any(not path.is_file() or path.stat().st_size == 0 for path in libraries):
            broken.append(extraction)
    if not broken:
        return
    # Clearing just the extraction is insufficient if Cargo reuses old build
    # output/link directives. Invalidate only the owning package first. On a
    # clean failure leave extractions intact so a later attempt still detects it.
    subprocess.run([
        "cargo", "clean", "--frozen", "--manifest-path", str(manifest), "--target-dir",
        str(target_dir), "-p", "sherpa-onnx-sys",
    ], check=True)
    for extraction in broken:
        shutil.rmtree(extraction)
    print(f"Repaired {len(broken)} incomplete Sherpa extraction(s); kept archives and healthy caches.")


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1]:
        raise SystemExit("Usage: repair-sherpa-cache.py <resolved-cargo-target-directory>")
    repair(Path(sys.argv[1]).resolve())
