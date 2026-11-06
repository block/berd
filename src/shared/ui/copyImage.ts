// Longer than a healthy local fetch/decode, short enough to make retry useful.
const IMAGE_PREPARATION_TIMEOUT_MS = 10_000;

function canvasPng(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height) {
    throw new Error("Image pixels are unavailable");
  }
  context.drawImage(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    canvas.toBlob((png) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (png) resolve(png);
      else reject(new Error("Failed to encode clipboard image"));
    }, "image/png");
  });
}

function decodeImage(
  url: string,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = document.createElement("img");
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      image.removeAttribute("src");
      reject(signal.reason);
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("Failed to decode image"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else image.src = url;
  });
}

/** Preserve fetched PNG bytes; normalize displayed blob previews and other formats. */
async function clipboardPng(
  src: string,
  signal: AbortSignal,
  image?: HTMLImageElement,
): Promise<Blob> {
  signal.throwIfAborted();
  if (src.startsWith("blob:")) {
    // Blob previews are displayable under CSP, but not fetchable. Copy the
    // already-loaded same-origin preview, never the resized agent payload.
    if (!image || image.getAttribute("src") !== src) {
      throw new Error("Image pixels are unavailable");
    }
    const loaded = image.complete ? image : await decodeImage(src, signal);
    signal.throwIfAborted();
    if (image.getAttribute("src") !== src)
      throw new Error("Image changed during copy");
    return canvasPng(loaded, signal);
  }
  const response = await fetch(src, { signal });
  signal.throwIfAborted();
  if (!response.ok)
    throw new Error(`Failed to fetch image (${response.status})`);
  const blob = await response.blob();
  signal.throwIfAborted();
  if (blob.type.split(";")[0].trim().toLowerCase() === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const decoded = await decodeImage(url, signal);
    signal.throwIfAborted();
    return await canvasPng(decoded, signal);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copy pixels through the browser API. Cancelling preparation rejects the
 * supplied PNG promise, so late fetch/decode results cannot update clipboard. */
export async function copyImage(
  src: string,
  options: { image?: HTMLImageElement; signal?: AbortSignal } = {},
): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is unavailable");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new Error("Image preparation timed out")),
    IMAGE_PREPARATION_TIMEOUT_MS,
  );
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      controller.signal.removeEventListener("abort", onAbort);
    if (controller.signal.aborted) onAbort();
  });
  const png = Promise.race([
    clipboardPng(src, controller.signal, options.image),
    aborted,
  ]);
  void png.catch(() => {});
  try {
    controller.signal.throwIfAborted();
    // Start write in the menu selection, before awaiting any image preparation.
    const writing = navigator.clipboard.write([
      new ClipboardItem({ "image/png": png }),
    ]);
    await Promise.race([writing, aborted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.abort();
    removeAbortListener();
  }
}
