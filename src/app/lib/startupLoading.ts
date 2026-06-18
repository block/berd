/** `startup-loading.gif` — keep in sync with `scripts/build-startup-loading-gif.sh` output. */
export const STARTUP_LOADING_GIF_FRAME_COUNT = 62;
export const STARTUP_LOADING_GIF_FPS = 24;
const STARTUP_LOADING_LOOP_COUNT = 2;

const STARTUP_LOADING_GIF_LOOP_MS = Math.round(
  (STARTUP_LOADING_GIF_FRAME_COUNT / STARTUP_LOADING_GIF_FPS) * 1000,
);

/** Minimum time the startup loader stays visible (~two full GIF loops). */
export const STARTUP_LOADING_MIN_DISPLAY_MS =
  STARTUP_LOADING_LOOP_COUNT * STARTUP_LOADING_GIF_LOOP_MS;

/** 64px base logo size, scaled up ~30% for the startup loader. */
export const STARTUP_LOADING_LOGO_SIZE_PX = 83;
