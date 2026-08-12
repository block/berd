const FALLBACK_TIMEOUT_MS = 120;

export function scheduleAfterNextPaint(callback: () => void): () => void {
  let didFinish = false;
  let frameId: number | null = null;
  let postFrameTimeoutId: number | null = null;
  let fallbackTimeoutId: number | null = null;

  const clearPendingWork = () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (postFrameTimeoutId !== null) {
      window.clearTimeout(postFrameTimeoutId);
      postFrameTimeoutId = null;
    }
    if (fallbackTimeoutId !== null) {
      window.clearTimeout(fallbackTimeoutId);
      fallbackTimeoutId = null;
    }
  };

  const run = () => {
    if (didFinish) {
      return;
    }

    didFinish = true;
    clearPendingWork();
    callback();
  };

  frameId = window.requestAnimationFrame(() => {
    frameId = null;
    postFrameTimeoutId = window.setTimeout(() => {
      postFrameTimeoutId = null;
      run();
    }, 0);
  });

  fallbackTimeoutId = window.setTimeout(() => {
    fallbackTimeoutId = null;
    run();
  }, FALLBACK_TIMEOUT_MS);

  return () => {
    if (didFinish) {
      return;
    }
    didFinish = true;
    clearPendingWork();
  };
}
