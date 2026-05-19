import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const avatarRoot = join(rootDir, "src/shared/assets/avatars");

const formats = {
  webm: {
    dir: join(avatarRoot, "webm"),
    extensions: new Set([".webm"]),
  },
  hevc: {
    dir: join(avatarRoot, "hevc"),
    extensions: new Set([".mov", ".mp4"]),
  },
};

function resolveAvatarFormat() {
  const explicitFormat = process.env.GOOSE_AVATAR_FORMAT?.toLowerCase();
  if (explicitFormat === "webm" || explicitFormat === "hevc") {
    return explicitFormat;
  }
  if (explicitFormat) {
    throw new Error(
      `Unsupported GOOSE_AVATAR_FORMAT "${explicitFormat}". Expected "webm" or "hevc".`,
    );
  }

  const isDarwinTarget =
    process.env.TAURI_ENV_PLATFORM === "darwin" ||
    process.env.TAURI_ENV_TARGET_TRIPLE?.endsWith("-darwin") === true;

  return isDarwinTarget ? "hevc" : "webm";
}

function walkFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    return [dir];
  }

  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    files.push(...walkFiles(join(dir, entry.name)));
  }
  return files;
}

function avatarAssetFiles(format) {
  const { dir, extensions } = formats[format];
  return walkFiles(dir)
    .filter((filePath) => extensions.has(extname(filePath).toLowerCase()))
    .sort();
}

function avatarAssetId(format, filePath) {
  const { dir } = formats[format];
  const relativePath = relative(dir, filePath).replace(/\\/g, "/");
  return relativePath.slice(0, -extname(relativePath).length);
}

function isLfsPointer(filePath) {
  const filePrefix = readFileSync(filePath).subarray(0, 128).toString("utf8");
  return filePrefix.startsWith("version https://git-lfs.github.com/spec/v1");
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }

  return [...duplicates].sort();
}

const selectedFormat = resolveAvatarFormat();
const filesByFormat = {
  webm: avatarAssetFiles("webm"),
  hevc: avatarAssetFiles("hevc"),
};
const idsByFormat = {
  webm: new Set(filesByFormat.webm.map((file) => avatarAssetId("webm", file))),
  hevc: new Set(filesByFormat.hevc.map((file) => avatarAssetId("hevc", file))),
};
const duplicateHevcIds = duplicateValues(
  filesByFormat.hevc.map((file) => avatarAssetId("hevc", file)),
);

const failures = [];

if (filesByFormat.webm.length === 0) {
  failures.push(
    "No WebM avatar assets found in src/shared/assets/avatars/webm.",
  );
}

if (filesByFormat[selectedFormat].length === 0) {
  failures.push(
    `Avatar format "${selectedFormat}" is selected, but no matching assets were found.`,
  );
}

for (const filePath of [...filesByFormat.webm, ...filesByFormat.hevc]) {
  if (isLfsPointer(filePath)) {
    failures.push(
      `${relative(rootDir, filePath)} is an LFS pointer file. Run git lfs pull before building.`,
    );
  }
}

if (idsByFormat.hevc.size > 0) {
  if (duplicateHevcIds.length > 0) {
    failures.push(
      `HEVC avatar assets contain duplicate ids across extensions: ${duplicateHevcIds.join(", ")}.`,
    );
  }

  const missingHevc = difference(idsByFormat.webm, idsByFormat.hevc);
  const extraHevc = difference(idsByFormat.hevc, idsByFormat.webm);

  if (missingHevc.length > 0) {
    failures.push(
      `HEVC avatar assets are missing ids present in WebM: ${missingHevc.join(", ")}.`,
    );
  }

  if (extraHevc.length > 0) {
    failures.push(
      `HEVC avatar assets contain ids not present in WebM: ${extraHevc.join(", ")}.`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`avatar assets: ${failure}`);
  }
  process.exit(1);
}

console.log(
  `avatar assets ok: selected=${selectedFormat}, webm=${filesByFormat.webm.length}, hevc=${filesByFormat.hevc.length}`,
);
