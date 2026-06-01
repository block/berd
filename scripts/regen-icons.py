#!/usr/bin/env python3
"""Regenerate Tauri icon assets from src-tauri/icons/icon.png.

Preserves the source PNG colorspace chunks (sRGB / iCCP / cHRM / gAMA) so
the rasterized icons keep the same color tagging as the export.
"""
import os
import struct
import subprocess
import tempfile

from PIL import Image, PngImagePlugin

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
SRC = os.path.join(ROOT, "src-tauri/icons/icon.png")
ICONS_DIR = os.path.join(ROOT, "src-tauri/icons")

with open(SRC, "rb") as f:
    raw = f.read()
assert raw[:8] == b"\x89PNG\r\n\x1a\n"

src_chunks: dict[str, list[bytes]] = {}
i = 8
while i < len(raw):
    ln = struct.unpack(">I", raw[i : i + 4])[0]
    typ = raw[i + 4 : i + 8].decode("ascii", "replace")
    data = raw[i + 8 : i + 8 + ln]
    if typ != "IDAT":
        src_chunks.setdefault(typ, []).append(data)
    i += 8 + ln + 4
print("source chunks:", {k: [len(d) for d in v] for k, v in src_chunks.items()})

src_img = Image.open(SRC).convert("RGBA")


def make_pnginfo() -> PngImagePlugin.PngInfo:
    info = PngImagePlugin.PngInfo()
    for tag in ("sRGB", "iCCP", "cHRM", "gAMA"):
        if tag in src_chunks:
            info.add(tag.encode("ascii"), src_chunks[tag][0])
    return info


def resize(sz: int) -> Image.Image:
    return src_img.resize((sz, sz), Image.Resampling.LANCZOS)


def save_png(img: Image.Image, path: str) -> None:
    img.save(path, "PNG", pnginfo=make_pnginfo(), optimize=True)
    print("wrote", os.path.relpath(path, ROOT), img.size)


for name, sz in [
    ("32x32.png", 32),
    ("64x64.png", 64),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
]:
    save_png(resize(sz), os.path.join(ICONS_DIR, name))

for name, sz in [
    ("Square30x30Logo.png", 30),
    ("Square44x44Logo.png", 44),
    ("Square71x71Logo.png", 71),
    ("Square89x89Logo.png", 89),
    ("Square107x107Logo.png", 107),
    ("Square142x142Logo.png", 142),
    ("Square150x150Logo.png", 150),
    ("Square284x284Logo.png", 284),
    ("Square310x310Logo.png", 310),
    ("StoreLogo.png", 50),
]:
    save_png(resize(sz), os.path.join(ICONS_DIR, name))

for name, sz in [
    ("AppIcon-20x20@1x.png", 20),
    ("AppIcon-20x20@2x.png", 40),
    ("AppIcon-20x20@2x-1.png", 40),
    ("AppIcon-20x20@3x.png", 60),
    ("AppIcon-29x29@1x.png", 29),
    ("AppIcon-29x29@2x.png", 58),
    ("AppIcon-29x29@2x-1.png", 58),
    ("AppIcon-29x29@3x.png", 87),
    ("AppIcon-40x40@1x.png", 40),
    ("AppIcon-40x40@2x.png", 80),
    ("AppIcon-40x40@2x-1.png", 80),
    ("AppIcon-40x40@3x.png", 120),
    ("AppIcon-60x60@2x.png", 120),
    ("AppIcon-60x60@3x.png", 180),
    ("AppIcon-76x76@1x.png", 76),
    ("AppIcon-76x76@2x.png", 152),
    ("AppIcon-83.5x83.5@2x.png", 167),
    ("AppIcon-512@2x.png", 1024),
]:
    save_png(resize(sz), os.path.join(ICONS_DIR, "ios", name))

for dirname, base, fg in [
    ("mipmap-mdpi", 48, 108),
    ("mipmap-hdpi", 72, 162),
    ("mipmap-xhdpi", 96, 216),
    ("mipmap-xxhdpi", 144, 324),
    ("mipmap-xxxhdpi", 192, 432),
]:
    out_dir = os.path.join(ICONS_DIR, "android", dirname)
    save_png(resize(base), os.path.join(out_dir, "ic_launcher.png"))
    save_png(resize(base), os.path.join(out_dir, "ic_launcher_round.png"))
    save_png(resize(fg), os.path.join(out_dir, "ic_launcher_foreground.png"))

with tempfile.TemporaryDirectory() as tmp:
    iconset = os.path.join(tmp, "icon.iconset")
    os.makedirs(iconset)
    for name, sz in [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]:
        save_png(resize(sz), os.path.join(iconset, name))
    icns_out = os.path.join(ICONS_DIR, "icon.icns")
    subprocess.run(["iconutil", "-c", "icns", "-o", icns_out, iconset], check=True)
    print("wrote", os.path.relpath(icns_out, ROOT))

ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico_path = os.path.join(ICONS_DIR, "icon.ico")
resize(max(ico_sizes)).save(
    ico_path,
    format="ICO",
    sizes=[(s, s) for s in ico_sizes],
)
print("wrote", os.path.relpath(ico_path, ROOT))
