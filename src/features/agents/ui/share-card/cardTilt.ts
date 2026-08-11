export const AGENT_CARD_TILT_DEGREES = 8;

export function updateCardTilt(
  element: HTMLElement,
  pointer: { clientX: number; clientY: number },
  tilt = AGENT_CARD_TILT_DEGREES,
  stableBounds = element.getBoundingClientRect(),
): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const bounds = stableBounds;
  const x = ((pointer.clientX - bounds.left) / bounds.width - 0.5) * 2;
  const y = ((pointer.clientY - bounds.top) / bounds.height - 0.5) * 2;
  element.style.transition = "transform 110ms cubic-bezier(0.2, 0.7, 0.2, 1)";
  element.style.transform = `rotateX(${-y * tilt}deg) rotateY(${x * tilt}deg)`;
}

export function resetCardTilt(element: HTMLElement): void {
  element.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
  element.style.transform = "none";
}
