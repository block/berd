#!/usr/bin/env bash
# Create a styled macOS DMG from a built Berd.app bundle.

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/package-macos-dmg.sh path/to/Berd.app path/to/Berd.dmg

Creates a styled drag-to-Applications DMG with a branded background image.
USAGE
  exit 1
}

[[ $# -eq 2 ]] || usage

app_path="$1"
out_dmg="$2"
app_name="$(basename "$app_path")"
vol_name="${VOL_NAME:-Berd}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
background="$script_dir/assets/dmg-background.png"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/Berd-dmg.XXXXXX")"
rw_dmg="$work_root/rw-Berd.dmg"
dmg_root="$work_root/root"
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

if [[ ! -f "$background" ]]; then
  echo "DMG background not found: $background" >&2
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
    set position of item appName of dmgRoot to {410, 240}
    set position of item "Applications" of dmgRoot to {655, 240}
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
