const DEFAULT_CSS_ZOOM = 1;

export function readTranscriptElementBlockSize(element: HTMLElement): number {
  const visualBlockSize = element.getBoundingClientRect().height;
  const cssZoom = readCumulativeCssZoom(element);

  return Math.ceil(visualBlockSize / cssZoom);
}

function readCumulativeCssZoom(element: HTMLElement): number {
  if (typeof window === "undefined" || !window.getComputedStyle) {
    return DEFAULT_CSS_ZOOM;
  }

  let cssZoom = DEFAULT_CSS_ZOOM;
  let current: HTMLElement | null = element;

  while (current) {
    const currentZoom = readElementCssZoom(current);
    cssZoom *= currentZoom;
    current = current.parentElement;
  }

  return cssZoom;
}

function readElementCssZoom(element: HTMLElement): number {
  return (
    parseCssZoom(window.getComputedStyle(element).getPropertyValue("zoom")) ??
    parseCssZoom(element.style.getPropertyValue("zoom")) ??
    DEFAULT_CSS_ZOOM
  );
}

function parseCssZoom(value: string): number | null {
  const trimmed = value.trim();
  const isPercentage = trimmed.endsWith("%");
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return isPercentage ? parsed / 100 : parsed;
}
