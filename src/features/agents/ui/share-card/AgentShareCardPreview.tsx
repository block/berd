import { useEffect, useId, useMemo, useState } from "react";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import cardFoil from "@/features/agents/assets/share-card/card-foil.png";
import berdCardLogo from "@/features/agents/assets/share-card/berd-card-logo.svg";
import { HolographicAgentCard } from "./HolographicAgentCard";
import {
  fallbackAgentCardColor,
  sampleAgentAvatarColor,
} from "./agentCardColor";
import {
  deriveAgentCardTraitLines,
  deriveAgentShareCardTextLayout,
} from "./agentShareCardLayout";
import { loadAgentCardFonts } from "./agentShareCardFonts";
import type { AgentShareCardCopy } from "./agentShareCardCopy";
import {
  AGENT_CARD_GEOMETRY,
  agentCardFramePath,
} from "./agentShareCardGeometry";

function createAgentCardTextMeasure() {
  const canvas = document.createElement("canvas");
  const context = /jsdom/u.test(navigator.userAgent)
    ? null
    : canvas.getContext("2d");
  return (text: string, font: string) => {
    if (!context) return Array.from(text).length * 42;
    context.font = font;
    return context.measureText(text).width;
  };
}

interface AgentShareCardPreviewProps {
  identity: string;
  displayName: string;
  description: string;
  avatarSrc?: string;
  alt: string;
  copy: AgentShareCardCopy;
  locale: string;
}

export function AgentShareCardPreview({
  identity,
  displayName,
  description,
  avatarSrc,
  alt,
  copy,
  locale,
}: AgentShareCardPreviewProps) {
  const resolvedAvatarSrc = avatarSrc ?? resolveAgentIcon(identity);
  const markFilterId = `berd-card-mark-${useId().replaceAll(":", "")}`;
  const [fontGeneration, setFontGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    void loadAgentCardFonts().then(() => {
      if (active) setFontGeneration((generation) => generation + 1);
    });
    return () => {
      active = false;
    };
  }, []);
  const textLayout = useMemo(() => {
    void fontGeneration;
    const measure = createAgentCardTextMeasure();
    return deriveAgentShareCardTextLayout(
      displayName,
      description,
      (value) => measure(value, "600 64px Inter, sans-serif"),
      (value) => measure(value, "600 42px Inter, sans-serif"),
      locale,
    );
  }, [description, displayName, fontGeneration, locale]);
  const [accentColor, setAccentColor] = useState(() =>
    fallbackAgentCardColor(identity),
  );

  useEffect(() => {
    let active = true;
    setAccentColor(fallbackAgentCardColor(identity));
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const sampled = sampleAgentAvatarColor(image);
      if (active && sampled) setAccentColor(sampled);
    };
    image.src = resolvedAvatarSrc;
    return () => {
      active = false;
      image.onload = null;
    };
  }, [identity, resolvedAvatarSrc]);

  const geometry = AGENT_CARD_GEOMETRY;
  const traitMeasure = createAgentCardTextMeasure();
  const goodForLines = deriveAgentCardTraitLines(
    copy.goodForLabel,
    copy.goodFor,
    geometry.goodFor.width,
    (value) => traitMeasure(value, "600 42px Inter, sans-serif"),
    locale,
  );
  const vibesLines = deriveAgentCardTraitLines(
    copy.vibesLabel,
    copy.vibes,
    geometry.vibes.width,
    (value) => traitMeasure(value, "600 42px Inter, sans-serif"),
    locale,
  );
  const { title, descriptionLines, contentShift } = textLayout;
  const descriptionLineKeys = descriptionLines.map(
    (line, index) =>
      `${line}:${descriptionLines.slice(0, index).filter((item) => item === line).length}`,
  );

  return (
    <HolographicAgentCard src={cardFoil} alt={alt} shadowColor={accentColor}>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[1] size-full"
        viewBox="0 0 1227 1839"
      >
        <path
          d={agentCardFramePath()}
          fill={accentColor}
          fillRule="evenodd"
          opacity="0.34"
          style={{ mixBlendMode: "color" }}
        />
      </svg>
      <svg
        aria-hidden="true"
        className="absolute inset-0 z-[2] size-full"
        viewBox="0 0 1227 1839"
      >
        <rect
          x={geometry.panel.x}
          y={geometry.panel.y}
          width={geometry.panel.width}
          height={geometry.panel.height}
          rx={geometry.panel.radius}
          fill="white"
          fillOpacity="0.95"
        />
      </svg>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[3] size-full opacity-[var(--agent-card-pattern-opacity,0)] transition-opacity duration-150 motion-reduce:hidden"
        viewBox="0 0 1227 1839"
      >
        <defs>
          <pattern
            id={`${markFilterId}-waves`}
            width="160"
            height="96"
            patternUnits="userSpaceOnUse"
          >
            <g fill="none" stroke={accentColor} strokeWidth="1.4">
              {[8, 20, 32, 44, 56, 68, 80, 92].map((y) => (
                <path
                  key={y}
                  d={`M-40 ${y} C-20 ${y - 12} 0 ${y - 12} 20 ${y} S60 ${y + 12} 80 ${y} S120 ${y - 12} 140 ${y} S180 ${y + 12} 200 ${y}`}
                />
              ))}
            </g>
          </pattern>
          <radialGradient id={`${markFilterId}-reveal`}>
            <stop offset="0" stopColor="white" stopOpacity="1" />
            <stop offset="0.35" stopColor="white" stopOpacity="0.82" />
            <stop offset="0.7" stopColor="white" stopOpacity="0.25" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <mask id={`${markFilterId}-mask`} maskUnits="userSpaceOnUse">
            <circle
              cx="var(--agent-card-pattern-svg-x, -500)"
              cy="var(--agent-card-pattern-svg-y, -500)"
              r="330"
              fill={`url(#${markFilterId}-reveal)`}
            />
          </mask>
        </defs>
        <rect
          x={geometry.panel.x}
          y={geometry.panel.y}
          width={geometry.panel.width}
          height={geometry.panel.height}
          rx={geometry.panel.radius}
          fill={`url(#${markFilterId}-waves)`}
          mask={`url(#${markFilterId}-mask)`}
        />
      </svg>
      <svg
        aria-hidden="true"
        className="absolute inset-0 z-[4] size-full"
        viewBox="0 0 1227 1839"
      >
        <image
          href={berdCardLogo}
          x={geometry.logo.x}
          y={geometry.logo.y}
          width={geometry.logo.width}
          height={geometry.logo.height}
        />
        <text
          x="1110"
          y="153"
          fill="black"
          fontFamily="Inter, sans-serif"
          fontSize="36"
          fontWeight="600"
          textAnchor="end"
        >
          {/* i18n-check-ignore: fixed brand text embedded in shareable card artwork */}
          BERD AGENT
        </text>

        <image
          href={avatarSrc ?? resolveAgentIcon(identity)}
          x={geometry.avatar.x}
          y={geometry.avatar.y}
          width={geometry.avatar.width}
          height={geometry.avatar.height}
          preserveAspectRatio="xMidYMid meet"
        />

        <foreignObject
          x={geometry.title.x}
          y={1306 - contentShift}
          width={geometry.title.width}
          height="78"
        >
          <div className="truncate font-sans text-[64px] font-semibold leading-none text-black">
            {title}
          </div>
        </foreignObject>
        <text
          x={geometry.description.x}
          y={geometry.description.y - contentShift}
          fill="black"
          fontFamily="Inter, sans-serif"
          fontSize="42"
          fontWeight="600"
        >
          {descriptionLines.map((line, index) => (
            <tspan
              key={descriptionLineKeys[index]}
              x={geometry.description.x}
              dy={index === 0 ? 0 : geometry.description.lineHeight}
            >
              {line}
            </tspan>
          ))}
        </text>

        <line
          x1={geometry.goodFor.ruleX}
          x2={geometry.goodFor.ruleX}
          y1={geometry.traitRule.y1}
          y2={geometry.traitRule.y2}
          stroke="black"
          strokeWidth={geometry.traitRule.width}
        />
        <line
          x1={geometry.vibes.ruleX}
          x2={geometry.vibes.ruleX}
          y1={geometry.traitRule.y1}
          y2={geometry.traitRule.y2}
          stroke="black"
          strokeWidth={geometry.traitRule.width}
        />
        <text
          x={geometry.goodFor.copyX}
          y={geometry.traitCopyY}
          fill="black"
          fontFamily="Inter, sans-serif"
          fontSize="42"
          fontWeight="600"
        >
          {goodForLines.map((line, index) => (
            <tspan
              key={`good-for:${line}`}
              x={geometry.goodFor.copyX}
              dy={index === 0 ? 0 : 50}
            >
              {line}
            </tspan>
          ))}
        </text>
        <text
          x={geometry.vibes.copyX}
          y={geometry.traitCopyY}
          fill="black"
          fontFamily="Inter, sans-serif"
          fontSize="42"
          fontWeight="600"
        >
          {vibesLines.map((line, index) => (
            <tspan
              key={`vibes:${line}`}
              x={geometry.vibes.copyX}
              dy={index === 0 ? 0 : 50}
            >
              {line}
            </tspan>
          ))}
        </text>
      </svg>
    </HolographicAgentCard>
  );
}
