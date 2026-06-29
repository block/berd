#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_WEBM="${ROOT}/src/app/assets/berd-startup-loading.webm"
ASSETS="${ROOT}/src/app/assets"
# Match native WebM resolution so the GIF is not upscaled or over-downscaled.
SIZE=250
GIF_FPS=24
# Sidebar chat activity indicator — same loop, faster wing flap (~1.6×).
CHAT_GIF_SPEED=1.6
CHAT_GIF_FPS=24
FILTER="[0:v]scale=${SIZE}:${SIZE}:flags=lanczos,format=rgba,alphaextract[alpha];color=0x242424ff:s=${SIZE}x${SIZE}[color];[color][alpha]alphamerge=shortest=1"

ffmpeg -y -c:v libvpx-vp9 -i "${SRC_WEBM}" \
  -filter_complex "${FILTER},fps=${GIF_FPS},split[s0][s1];[s0]palettegen=reserve_transparent=1:stats_mode=diff[p];[s1][p]paletteuse=dither=none" \
  -loop 0 "${ASSETS}/startup-loading.gif"

ffmpeg -y -c:v libvpx-vp9 -i "${SRC_WEBM}" \
  -filter_complex "${FILTER},setpts=PTS/${CHAT_GIF_SPEED},fps=${CHAT_GIF_FPS},split[s0][s1];[s0]palettegen=reserve_transparent=1:stats_mode=diff[p];[s1][p]paletteuse=dither=none" \
  -loop 0 "${ASSETS}/startup-loading-chat.gif"

ffmpeg -y -c:v libvpx-vp9 -i "${SRC_WEBM}" \
  -filter_complex "${FILTER}" \
  -frames:v 1 \
  -pix_fmt rgba \
  "${ASSETS}/startup-loading-poster.png"

if [[ -d "${ROOT}/public" ]]; then
  cp "${ASSETS}/startup-loading-poster.png" "${ROOT}/public/berd-startup-loading-poster.png"
fi

echo "Wrote startup-loading.gif, startup-loading-chat.gif, and startup-loading-poster.png (${SIZE}px)"
