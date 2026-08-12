#!/usr/bin/env bash
# Create a styled macOS DMG from a built Berd.app bundle.

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/package-macos-dmg.sh path/to/Berd.app path/to/Berd.dmg

Creates a styled drag-to-Applications DMG with a generated background image.
USAGE
  exit 1
}

[[ $# -eq 2 ]] || usage

app_path="$1"
out_dmg="$2"
app_name="$(basename "$app_path")"
vol_name="${VOL_NAME:-Berd}"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/Berd-dmg.XXXXXX")"
rw_dmg="$work_root/rw-Berd.dmg"
dmg_root="$work_root/root"
background="$work_root/background.png"
applescript="$work_root/style-dmg.applescript"

cleanup() {
  hdiutil detach "/Volumes/$vol_name" >/dev/null 2>&1 || true
  rm -rf "$work_root"
}
trap cleanup EXIT

if [[ ! -d "$app_path" ]]; then
  echo "App bundle not found: $app_path" >&2
  exit 1
fi

detach_existing_mounts() {
  local mount
  while IFS= read -r mount; do
    [[ -n "$mount" ]] || continue
    echo "Detaching existing DMG mount $mount" >&2
    hdiutil detach "$mount" >/dev/null 2>&1 || hdiutil detach -force "$mount" >/dev/null 2>&1 || true
  done < <(find /Volumes -maxdepth 1 \( -name "$vol_name" -o -name "$vol_name *" \) -print 2>/dev/null || true)
}

generate_background() {
  local output="$1"
  local generator="$work_root/generate-dmg-background.swift"
  cat >"$generator" <<'SWIFT'
import AppKit
import Foundation

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let canvas = NSSize(width: 800, height: 400)
let image = NSImage(size: canvas)

func color(_ hex: UInt32) -> NSColor {
  NSColor(
    calibratedRed: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: 1
  )
}

image.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: canvas).fill()

let ink = color(0x050505)
let gold = color(0xffd43b)

let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 326, y: 178))
arrow.curve(
  to: NSPoint(x: 464, y: 178),
  controlPoint1: NSPoint(x: 372, y: 202),
  controlPoint2: NSPoint(x: 420, y: 202)
)
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
arrow.lineWidth = 6
ink.setStroke()
arrow.stroke()

let head = NSBezierPath()
head.move(to: NSPoint(x: 464, y: 178))
head.line(to: NSPoint(x: 438, y: 155))
head.move(to: NSPoint(x: 464, y: 178))
head.line(to: NSPoint(x: 438, y: 201))
head.lineCapStyle = .round
head.lineJoinStyle = .round
head.lineWidth = 6
ink.setStroke()
head.stroke()

let burstA = NSBezierPath(roundedRect: NSRect(x: 642, y: 250, width: 10, height: 28), xRadius: 3, yRadius: 3)
var transformA = AffineTransform()
transformA.translate(x: 647, y: 264)
transformA.rotate(byDegrees: -6)
transformA.translate(x: -647, y: -264)
burstA.transform(using: transformA)
gold.setFill()
burstA.fill()
ink.setStroke()
burstA.lineWidth = 3
burstA.stroke()

let burstB = NSBezierPath(roundedRect: NSRect(x: 664, y: 236, width: 10, height: 32), xRadius: 3, yRadius: 3)
var transformB = AffineTransform()
transformB.translate(x: 669, y: 252)
transformB.rotate(byDegrees: 42)
transformB.translate(x: -669, y: -252)
burstB.transform(using: transformB)
gold.setFill()
burstB.fill()
ink.setStroke()
burstB.lineWidth = 3
burstB.stroke()

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  fatalError("failed to render DMG background")
}
try png.write(to: output)
SWIFT

  /usr/bin/swift "$generator" "$output"
}

detach_retry() {
  local device="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    if hdiutil detach "$device" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  hdiutil detach -force "$device" >/dev/null
}

detach_existing_mounts
mkdir -p "$dmg_root/.background"
ditto "$app_path" "$dmg_root/$app_name"
ln -s /Applications "$dmg_root/Applications"
generate_background "$background"
cp "$background" "$dmg_root/.background/background.png"

rm -f "$rw_dmg" "$out_dmg"
hdiutil create -volname "$vol_name" -srcfolder "$dmg_root" -ov -format UDRW "$rw_dmg" >/dev/null

mount_output="$(hdiutil attach -readwrite -noverify -noautoopen -nobrowse "$rw_dmg")"
device="$(printf '%s\n' "$mount_output" | awk '/^\/dev\// { print $1; exit }')"
mount_dir="$(printf '%s\n' "$mount_output" | awk '/\/Volumes\// { for (i=3; i<=NF; i++) { printf "%s%s", (i==3 ? "" : " "), $i }; printf "\n"; exit }')"
if [[ -z "$device" || -z "$mount_dir" ]]; then
  echo "Failed to attach writable DMG" >&2
  exit 1
fi

if command -v SetFile >/dev/null 2>&1; then
  SetFile -a V "$mount_dir/.background" || true
  if [[ -f "$mount_dir/$app_name/Contents/Resources/icon.icns" ]]; then
    cp "$mount_dir/$app_name/Contents/Resources/icon.icns" "$mount_dir/.VolumeIcon.icns" || true
    SetFile -c icnC "$mount_dir/.VolumeIcon.icns" || true
    SetFile -a C "$mount_dir" || true
  fi
fi

cat >"$applescript" <<'APPLESCRIPT'
on run argv
  set mountPath to item 1 of argv
  set appName to item 2 of argv
  tell application "Finder"
    set dmgRoot to POSIX file mountPath as alias
    open dmgRoot
    set dmgWindow to container window of dmgRoot
    set current view of dmgWindow to icon view
    set toolbar visible of dmgWindow to false
    set statusbar visible of dmgWindow to false
    set the bounds of dmgWindow to {200, 120, 1000, 520}
    set opts to the icon view options of dmgWindow
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 12
    set background picture of opts to file ".background:background.png" of dmgRoot
    set position of item appName of dmgRoot to {190, 210}
    set position of item "Applications" of dmgRoot to {590, 210}
    set the extension hidden of item appName of dmgRoot to true
    delay 1
    close dmgWindow
  end tell
end run
APPLESCRIPT

if command -v osascript >/dev/null 2>&1; then
  /usr/bin/osascript "$applescript" "$mount_dir" "$app_name" || true
fi

sync
detach_retry "$device"
hdiutil convert "$rw_dmg" -format UDZO -imagekey zlib-level=9 -o "$out_dmg" >/dev/null
echo "Styled DMG ready: $out_dmg"
