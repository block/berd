import { BERD_LOADER_LOOP_MS } from "@/shared/ui/berd-loader-timing";

const STARTUP_LOADING_LOOP_COUNT = 2;

/** Minimum time the startup loader stays visible (~two full loader loops). */
export const STARTUP_LOADING_MIN_DISPLAY_MS =
  STARTUP_LOADING_LOOP_COUNT * BERD_LOADER_LOOP_MS;

/** 70px source loader scaled up ~18% for the startup screen. */
export const STARTUP_LOADING_LOGO_SIZE_PX = 83;
