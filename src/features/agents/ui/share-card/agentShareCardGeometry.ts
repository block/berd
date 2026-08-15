export const AGENT_CARD_GEOMETRY = {
  width: 1227,
  height: 1839,
  outerRadius: 80,
  panel: { x: 30, y: 31, width: 1167, height: 1777, radius: 70 },
  logo: { x: 120, y: 122, width: 40, height: 40 },
  brand: { x: 1110, y: 153 },
  avatar: { x: 155, y: 240, width: 917, height: 920 },
  title: { x: 115, y: 1370, width: 997 },
  description: { x: 115, y: 1445, width: 997, lineHeight: 52 },
  goodFor: { ruleX: 120, copyX: 139, width: 500 },
  vibes: { ruleX: 700, copyX: 729, width: 373 },
  traitRule: { y1: 1585, y2: 1683, width: 4 },
  traitCopyY: 1614,
} as const;

export const AGENT_CARD_ASPECT_RATIO = `${AGENT_CARD_GEOMETRY.width}/${AGENT_CARD_GEOMETRY.height}`;

export function agentCardFramePath(): string {
  const { width, height, panel } = AGENT_CARD_GEOMETRY;
  const right = panel.x + panel.width;
  const bottom = panel.y + panel.height;
  return `M0 0H${width}V${height}H0Z M${panel.x} ${panel.y + panel.radius}Q${panel.x} ${panel.y} ${panel.x + panel.radius} ${panel.y}H${right - panel.radius}Q${right} ${panel.y} ${right} ${panel.y + panel.radius}V${bottom - panel.radius}Q${right} ${bottom} ${right - panel.radius} ${bottom}H${panel.x + panel.radius}Q${panel.x} ${bottom} ${panel.x} ${bottom - panel.radius}Z`;
}
