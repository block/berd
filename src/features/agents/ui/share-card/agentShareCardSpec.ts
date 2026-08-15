import { segmentCardGraphemes } from "./agentShareCardText";
import {
  AGENT_CARD_ASPECT_RATIO,
  AGENT_CARD_GEOMETRY,
} from "./agentShareCardGeometry";

export const AGENT_CARD_WIDTH = AGENT_CARD_GEOMETRY.width;
export const AGENT_CARD_HEIGHT = AGENT_CARD_GEOMETRY.height;
export { AGENT_CARD_ASPECT_RATIO };

const MAX_TITLE_GRAPHEMES = 26;
const CARD_MATCH_LOCALE = "en";

export function truncateAgentCardTitle(
  name: string,
  locale = CARD_MATCH_LOCALE,
): string {
  const title = name.trim().toLocaleUpperCase(locale) || "BERD AGENT";
  const graphemes = segmentCardGraphemes(title, locale);
  return graphemes.length > MAX_TITLE_GRAPHEMES
    ? `${graphemes.slice(0, MAX_TITLE_GRAPHEMES - 1).join("")}…`
    : title;
}

export type AgentCardTraitId =
  | "software"
  | "review"
  | "research"
  | "writing"
  | "design"
  | "planning"
  | "automation"
  | "data"
  | "support"
  | "default";

interface TraitRule {
  id: Exclude<AgentCardTraitId, "default">;
  keywords: readonly string[];
}

const TRAIT_RULES: readonly TraitRule[] = [
  {
    id: "software",
    keywords: [
      "code",
      "coding",
      "software",
      "developer",
      "programming",
      "implement",
      "debug",
    ],
  },
  {
    id: "review",
    keywords: ["review", "audit", "risk", "quality", "security", "critique"],
  },
  {
    id: "research",
    keywords: [
      "research",
      "investigate",
      "search",
      "source",
      "evidence",
      "discover",
    ],
  },
  {
    id: "writing",
    keywords: [
      "write",
      "writing",
      "draft",
      "edit",
      "copy",
      "content",
      "summarize",
    ],
  },
  {
    id: "design",
    keywords: [
      "design",
      "visual",
      "interface",
      "ux",
      "ui",
      "prototype",
      "creative",
    ],
  },
  {
    id: "planning",
    keywords: [
      "plan",
      "planning",
      "strategy",
      "roadmap",
      "organize",
      "coordinate",
    ],
  },
  {
    id: "automation",
    keywords: [
      "automate",
      "automation",
      "workflow",
      "repetitive",
      "script",
      "schedule",
    ],
  },
  {
    id: "data",
    keywords: [
      "data",
      "analyze",
      "analysis",
      "metric",
      "sql",
      "report",
      "insight",
    ],
  },
  {
    id: "support",
    keywords: ["help", "support", "troubleshoot", "guide", "explain", "teach"],
  },
];

const SPANISH_TRAIT_KEYWORDS: Readonly<
  Partial<Record<Exclude<AgentCardTraitId, "default">, readonly string[]>>
> = {
  software: [
    "código",
    "programación",
    "software",
    "desarrollador",
    "implementar",
    "depurar",
  ],
  review: [
    "revisión",
    "auditoría",
    "riesgo",
    "calidad",
    "seguridad",
    "crítica",
  ],
  research: [
    "investigar",
    "investigación",
    "buscar",
    "fuente",
    "evidencia",
    "descubrir",
  ],
  writing: [
    "escribir",
    "redacción",
    "borrador",
    "editar",
    "contenido",
    "resumir",
  ],
  design: [
    "diseño",
    "visual",
    "interfaz",
    "experiencia",
    "prototipo",
    "creativo",
  ],
  planning: ["plan", "planificación", "estrategia", "organizar", "coordinar"],
  automation: [
    "automatizar",
    "automatización",
    "flujo",
    "repetitivo",
    "programar",
  ],
  data: ["datos", "analizar", "análisis", "métrica", "informe", "perspectiva"],
  support: ["ayuda", "soporte", "solucionar", "guiar", "explicar", "enseñar"],
};

/** Returns a stable semantic id; localized presentation copy is resolved later. */
export function classifyAgentCardTraits(
  instructions: string,
): AgentCardTraitId {
  const normalized = instructions.toLocaleLowerCase(CARD_MATCH_LOCALE);
  let bestRule: TraitRule | undefined;
  let bestScore = 0;

  for (const rule of TRAIT_RULES) {
    const keywords = [
      ...rule.keywords,
      ...(SPANISH_TRAIT_KEYWORDS[rule.id] ?? []),
    ];
    const score = keywords.reduce((total, keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (
        total + (new RegExp(`\\b${escaped}\\b`, "u").test(normalized) ? 1 : 0)
      );
    }, 0);
    if (score > bestScore) {
      bestRule = rule;
      bestScore = score;
    }
  }

  return bestRule?.id ?? "default";
}
