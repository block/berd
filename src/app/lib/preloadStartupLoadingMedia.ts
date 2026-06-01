import startupLoadingGif from "@/app/assets/startup-loading.gif";
import startupLoadingPoster from "@/app/assets/startup-loading-poster.png";

/** Warm the startup loader assets before the first React paint. */
export function preloadStartupLoadingMedia() {
  for (const src of [startupLoadingGif, startupLoadingPoster]) {
    const image = new Image();
    image.src = src;
  }
}
