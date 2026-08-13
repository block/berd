import { useEffect, useId, useMemo, useState } from "react";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import cardFoil from "@/features/agents/assets/share-card/card-foil.png";
import berdCardLogo from "@/features/agents/assets/share-card/berd-card-logo.svg";
import { HolographicAgentCard } from "./HolographicAgentCard";
import {
  fallbackAgentCardColor,
  sampleAgentAvatarColor,
} from "./agentCardColor";
import { deriveAgentCardTraits } from "./agentShareCardSpec";
import { deriveAgentShareCardTextLayout } from "./agentShareCardLayout";

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
}

export function AgentShareCardPreview({
  identity,
  displayName,
  description,
  avatarSrc,
  alt,
}: AgentShareCardPreviewProps) {
  const resolvedAvatarSrc = avatarSrc ?? resolveAgentIcon(identity);
  const traits = deriveAgentCardTraits(description);
  const markFilterId = `berd-card-mark-${useId().replaceAll(":", "")}`;
  const [fontGeneration, setFontGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      document.fonts?.load("600 64px Inter"),
      document.fonts?.load("600 42px Inter"),
    ]).then(() => {
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
    );
  }, [description, displayName, fontGeneration]);
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
          d="M0 0H1227V1839H0Z M30 101Q30 31 100 31H1127Q1197 31 1197 101V1738Q1197 1808 1127 1808H100Q30 1808 30 1738Z"
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
          x="30"
          y="31"
          width="1167"
          height="1777"
          rx="70"
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
          x="30"
          y="31"
          width="1167"
          height="1777"
          rx="70"
          fill={`url(#${markFilterId}-waves)`}
          mask={`url(#${markFilterId}-mask)`}
        />
      </svg>
      <svg
        aria-hidden="true"
        className="absolute inset-0 z-[4] size-full"
        viewBox="0 0 1227 1839"
      >
        <image href={berdCardLogo} x="120" y="122" width="40" height="40" />
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
          x="155"
          y="240"
          width="917"
          height="920"
          preserveAspectRatio="xMidYMid meet"
        />

        <foreignObject x="115" y={1306 - contentShift} width="997" height="78">
          <div className="truncate font-sans text-[64px] font-semibold leading-none text-black">
            {title}
          </div>
        </foreignObject>
        <text
          x="115"
          y={1445 - contentShift}
          fill="black"
          fontFamily="Inter, sans-serif"
          fontSize="42"
          fontWeight="600"
        >
          {descriptionLines.map((line, index) => (
            <tspan
              key={descriptionLineKeys[index]}
              x="115"
              dy={index === 0 ? 0 : 52}
            >
              {line}
            </tspan>
          ))}
        </text>

        <line
          x1="120"
          x2="120"
          y1="1585"
          y2="1683"
          stroke="black"
          strokeWidth="4"
        />
        <line
          x1="700"
          x2="700"
          y1="1585"
          y2="1683"
          stroke="black"
          strokeWidth="4"
        />
        <foreignObject x="139" y="1580" width="500" height="110">
          <div className="font-sans text-[42px] font-semibold leading-[1.2] text-black">
            {/* i18n-check-ignore: fixed label embedded in shareable card artwork */}
            <strong className="font-semibold">Good for:</strong>{" "}
            {traits.goodFor}
          </div>
        </foreignObject>
        <foreignObject x="729" y="1580" width="373" height="110">
          <div className="font-sans text-[42px] font-semibold leading-[1.2] text-black">
            {/* i18n-check-ignore: fixed label embedded in shareable card artwork */}
            <strong className="font-semibold">Vibes:</strong> {traits.vibes}
          </div>
        </foreignObject>
      </svg>
    </HolographicAgentCard>
  );
}
