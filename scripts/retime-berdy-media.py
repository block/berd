#!/usr/bin/env python3
"""Verify/reproduce the lossless HEVC-alpha cadence fix (Python standard library).

Run from any directory:
  python3 scripts/retime-berdy-media.py            # verify checked-in assets
  python3 scripts/retime-berdy-media.py --apply   # retime original assets, idempotent
  python3 scripts/retime-berdy-media.py --restore # restore exact original bytes

The manifest pins original/output hashes and validated timescale field offsets.
Only mvhd/mdhd timescales change, NOT durations in ticks, sample/edit tables,
HEVC configuration or mdat. Movie/media clocks both speed up by 1.5. Retaining
all samples (including alpha and endpoints) avoids re-encoding or frame removal.
Native playback uses effective source speed / 1.5; never exceeds WebKit's 2x
full-frame threshold. No second variant, per-frame seeks, or extra media bytes.
"""

import argparse
import hashlib
import json
from pathlib import Path
import struct


def sha(data):
    return hashlib.sha256(data).hexdigest()


def mdat_sha(data):
    """Hash media payloads, including MP4 boxes with 64-bit extended sizes."""
    digest = hashlib.sha256()
    offset = 0
    payload_bytes = 0
    while offset < len(data):
        if len(data) - offset < 8:
            raise ValueError("Truncated MP4 box")
        size, kind = struct.unpack_from(">I4s", data, offset)
        header = 8
        if size == 1:
            if len(data) - offset < 16:
                raise ValueError("Truncated extended MP4 box")
            size = struct.unpack_from(">Q", data, offset + 8)[0]
            header = 16
        elif size == 0:
            size = len(data) - offset
        if size < header or offset + size > len(data):
            raise ValueError("Invalid MP4 box size")
        if kind == b"mdat":
            digest.update(data[offset + header:offset + size])
            payload_bytes += size - header
        offset += size
    if not payload_bytes:
        raise ValueError("Missing media payload")
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--apply", action="store_true")
    modes.add_argument("--restore", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "scripts/berdy-media.json").read_text())
    directory = root / "public/desktop-agent/berdy"
    pending = []
    for entry in manifest["assets"]:
        path = directory / entry["file"]
        data = path.read_bytes()
        digest = sha(data)
        if len(data) != entry["bytes"] or digest not in (
            entry["originalSha256"], entry["sha256"]
        ):
            raise SystemExit(f"Refusing unknown media: {path}")
        if not args.apply and not args.restore and digest != entry["sha256"]:
            raise SystemExit(f"Original media needs --apply: {path}")
        # Validate each transformation in both directions, even in verify mode.
        original = bytearray(data)
        retimed = bytearray(data)
        for offset in entry["timescaleOffsets"]:
            if data[offset - 16:offset - 12] not in (b"mvhd", b"mdhd"):
                raise SystemExit(f"Invalid clock offset: {path}")
            struct.pack_into(">I", original, offset, manifest["originalTimescale"])
            struct.pack_into(">I", retimed, offset, manifest["timescale"])
        if sha(original) != entry["originalSha256"] or sha(retimed) != entry["sha256"]:
            raise SystemExit(f"Unexpected timing transformation: {path}")
        if mdat_sha(original) != entry["mdatSha256"] or mdat_sha(retimed) != entry["mdatSha256"]:
            raise SystemExit(f"Unexpected media payload: {path}")
        output = original if args.restore else retimed
        if (args.apply or args.restore) and output != data:
            pending.append((path, output))
    # Fail validation of the entire catalog before writing any file.
    for path, data in pending:
        path.write_bytes(data)
    print(f"Verified {len(manifest['assets'])} HEVC-alpha clips; changed {len(pending)}.")


if __name__ == "__main__":
    main()
