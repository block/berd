/** Preserve PNG bytes; normalize other displayed formats for the clipboard. */
async function clipboardPng(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Failed to fetch image (${response.status})`);
  }
  const blob = await response.blob();
  if (blob.type.split(";")[0].trim().toLowerCase() === "image/png") {
    return blob;
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = document.createElement("img");
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to decode image"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) {
      throw new Error("Image pixels are unavailable");
    }
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error("Failed to encode clipboard image"));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copy actual image pixels; animated images copy their displayed first frame. */
export async function copyImage(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is unavailable");
  }
  // Pass the PNG promise immediately, while the browser still has the click's
  // user activation (important in WebKit); do not await decode before write.
  const png = clipboardPng(src);
  // Permission can reject before the browser consumes the PNG promise.
  // Observe its rejection too, without masking failures from write().
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
