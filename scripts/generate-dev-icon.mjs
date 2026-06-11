#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const [, scriptName, inputPath, outputPath, label = ""] = process.argv;

if (!inputPath || !outputPath) {
  console.error(
    `Usage: ${basename(scriptName)} <input-icns> <output-png-or-icns> [label]`,
  );
  process.exit(1);
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const DEV_BLUE = [69, 145, 244]; // #4591F4
const BADGE_BLUE = [13, 59, 140];

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readChunks(buffer) {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Input is not a PNG");
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  const idat = chunks
    .filter((chunk) => chunk.type === "IDAT")
    .map((chunk) => chunk.data);

  if (!ihdr || idat.length === 0) {
    throw new Error("PNG is missing IHDR or IDAT data");
  }

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error(
      `Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
    );
  }

  const sourceBytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * sourceBytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idat));
  const unfiltered = Buffer.alloc(width * height * sourceBytesPerPixel);

  let sourceOffset = 0;
  let targetOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left =
        x >= sourceBytesPerPixel
          ? unfiltered[targetOffset + x - sourceBytesPerPixel]
          : 0;
      const up = y > 0 ? unfiltered[targetOffset + x - stride] : 0;
      const upLeft =
        y > 0 && x >= sourceBytesPerPixel
          ? unfiltered[targetOffset + x - stride - sourceBytesPerPixel]
          : 0;

      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paethPredictor(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter: ${filter}`);

      unfiltered[targetOffset + x] = value & 0xff;
    }

    sourceOffset += stride;
    targetOffset += stride;
  }

  const pixels = Buffer.alloc(width * height * 4);
  for (
    let i = 0, j = 0;
    i < unfiltered.length;
    i += sourceBytesPerPixel, j += 4
  ) {
    pixels[j] = unfiltered[i];
    pixels[j + 1] = unfiltered[i + 1];
    pixels[j + 2] = unfiltered[i + 2];
    pixels[j + 3] = colorType === 6 ? unfiltered[i + 3] : 255;
  }

  return { width, height, pixels };
}

function makeChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, data])),
    8 + data.length,
  );
  return chunk;
}

function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", deflateSync(raw, { level: 9 })),
    makeChunk("IEND"),
  ]);
}

function recolorDevIcon(image) {
  const pixels = Buffer.from(image.pixels);

  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    const luminance =
      (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) /
      255;

    // Keep the white goose mark intact; recolor the dark rounded-square body
    // and its dark edge shading so the local build reads as a clean blue app.
    if (alpha <= 0.08 || luminance >= 0.48) continue;

    pixels[i] = DEV_BLUE[0];
    pixels[i + 1] = DEV_BLUE[1];
    pixels[i + 2] = DEV_BLUE[2];
  }

  return { ...image, pixels };
}

function run(command, args) {
  execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"] });
}

function addBadge(imagePath, outputPath, badgeLabel, width, height) {
  const trimmedLabel = badgeLabel.trim();
  if (!trimmedLabel) {
    writeFileSync(outputPath, readFileSync(imagePath));
    return;
  }

  const badgeScript = join(tempDir, "draw-badge.swift");
  writeFileSync(
    badgeScript,
    `
import AppKit
import Foundation

guard CommandLine.arguments.count == 4 else {
    fputs("Usage: draw-badge.swift <input-png> <output-png> <label>\\n", stderr)
    exit(1)
}

let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
var label = CommandLine.arguments[3]
    .replacingOccurrences(of: "\\n", with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)

guard let source = NSImage(contentsOfFile: inputPath),
      let representation = source.representations.max(by: { $0.pixelsWide < $1.pixelsWide }) else {
    fputs("Failed to load image: \\(inputPath)\\n", stderr)
    exit(1)
}

let size = NSSize(width: representation.pixelsWide, height: representation.pixelsHigh)
let output = NSImage(size: size)
output.lockFocus()
source.draw(in: NSRect(origin: .zero, size: size))

if !label.isEmpty {
    let visibleTextCharacters = 5
    if label.count > visibleTextCharacters {
        label = String(label.prefix(visibleTextCharacters)) + "..."
    }

    let badgeHeight = size.height * 0.23
    let minBadgeWidth = size.width * 0.4
    let maxBadgeWidth = size.width * 0.8
    let horizontalPadding = size.width * 0.035
    let minFontSize = size.height * 0.058
    var fontSize = badgeHeight * 0.84

    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.alignment = .center

    func attributes(_ fontSize: CGFloat) -> [NSAttributedString.Key: Any] {
        [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .semibold),
            .foregroundColor: NSColor(
                calibratedRed: CGFloat(${BADGE_BLUE[0]}) / 255.0,
                green: CGFloat(${BADGE_BLUE[1]}) / 255.0,
                blue: CGFloat(${BADGE_BLUE[2]}) / 255.0,
                alpha: 1.0
            ),
            .paragraphStyle: paragraphStyle,
        ]
    }

    func textSize(_ text: String, _ attributes: [NSAttributedString.Key: Any]) -> NSSize {
        (text as NSString).size(withAttributes: attributes)
    }

    var textAttributes = attributes(fontSize)
    var measuredText = textSize(label, textAttributes)
    let maxTextWidth = maxBadgeWidth - horizontalPadding * 2
    while measuredText.width > maxTextWidth && fontSize > minFontSize {
        fontSize -= 2
        textAttributes = attributes(fontSize)
        measuredText = textSize(label, textAttributes)
    }

    let badgeWidth = min(
        max(measuredText.width + horizontalPadding * 2, minBadgeWidth),
        maxBadgeWidth
    )
    let badgeX = (size.width - badgeWidth) / 2
    let badgeY = size.height * 0.12
    let cornerRadius = badgeHeight * 0.2
    let badgeRect = NSRect(x: badgeX, y: badgeY, width: badgeWidth, height: badgeHeight)

    NSColor(calibratedWhite: 1.0, alpha: 0.7).setFill()
    NSBezierPath(
        roundedRect: badgeRect,
        xRadius: cornerRadius,
        yRadius: cornerRadius
    ).fill()

    let textRect = NSRect(
        x: badgeX,
        y: badgeY + (badgeHeight - measuredText.height) / 2 - size.height * 0.004,
        width: badgeWidth,
        height: measuredText.height
    )
    (label as NSString).draw(in: textRect, withAttributes: textAttributes)
}

output.unlockFocus()

guard let tiffData = output.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiffData),
      let pngData = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Failed to encode badged icon\\n", stderr)
    exit(1)
}

try pngData.write(to: URL(fileURLWithPath: outputPath))
`,
  );

  const swiftModuleCacheDir = join(
    tmpdir(),
    "goose-dev-icon-swift-module-cache",
  );
  mkdirSync(swiftModuleCacheDir, { recursive: true });

  run("swift", [
    "-module-cache-path",
    swiftModuleCacheDir,
    badgeScript,
    imagePath,
    outputPath,
    trimmedLabel,
  ]);

  const normalizedPath = join(tempDir, "badged-normalized.png");
  run("sips", [
    "-z",
    String(height),
    String(width),
    outputPath,
    "--out",
    normalizedPath,
  ]);
  writeFileSync(outputPath, readFileSync(normalizedPath));
}

function encodeIcns(entries) {
  const totalLength =
    8 + entries.reduce((length, { data }) => length + 8 + data.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(totalLength, 4);

  const chunks = entries.map(({ type, data }) => {
    const chunk = Buffer.alloc(8 + data.length);
    chunk.write(type, 0, "ascii");
    chunk.writeUInt32BE(8 + data.length, 4);
    data.copy(chunk, 8);
    return chunk;
  });

  return Buffer.concat([header, ...chunks], totalLength);
}

const tempDir = mkdtempSync(join(tmpdir(), "goose-dev-icon-"));
const keepTemp = process.env.GOOSE_DEV_ICON_KEEP_TEMP === "1";

try {
  const basePng = join(tempDir, "base.png");
  const bluePng = join(tempDir, "blue.png");
  const badgedPng = join(tempDir, "badged.png");

  run("sips", ["-s", "format", "png", inputPath, "--out", basePng]);

  const decoded = decodePng(readFileSync(basePng));
  writeFileSync(bluePng, encodePng(recolorDevIcon(decoded)));
  addBadge(bluePng, badgedPng, label, decoded.width, decoded.height);

  if (!outputPath.endsWith(".icns")) {
    writeFileSync(outputPath, readFileSync(badgedPng));
    console.log(`Generated: ${outputPath}`);
  } else {
    const iconsetPath = join(tempDir, "goose-dev.iconset");
    mkdirSync(iconsetPath);

    const sizes = [
      ["icp4", "icon_16x16", 16],
      ["icp5", "icon_32x32", 32],
      ["icp6", "icon_32x32@2x", 64],
      ["ic07", "icon_128x128", 128],
      ["ic08", "icon_128x128@2x", 256],
      ["ic09", "icon_256x256@2x", 512],
      ["ic10", "icon_512x512@2x", 1024],
    ];

    const entries = [];
    for (const [type, name, size] of sizes) {
      const sizedPng = join(iconsetPath, `${name}.png`);
      run("sips", [
        "-z",
        String(size),
        String(size),
        badgedPng,
        "--out",
        sizedPng,
      ]);
      entries.push({ type, data: readFileSync(sizedPng) });
    }

    writeFileSync(outputPath, encodeIcns(entries));
    console.log(`Generated: ${outputPath}`);
  }
} finally {
  if (keepTemp) {
    console.error(`Kept temp icon directory: ${tempDir}`);
  } else {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
