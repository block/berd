// Custom webview context menu for the avatar — replaces the native
// NSMenu so rows can carry avatar previews and the chrome can match the
// popover's dark glass. The collapsed panel window is avatar-sized, so
// DesktopAgentApp grows the window first ("menu" panel mode, same
// anti-blink path as the chat popover) and renders this component inside
// the computed overlay region; this component only positions the menu
// card (and the "Switch agent" submenu) WITHIN that region.
//
// Keyboard: ArrowUp/Down move, ArrowRight/Enter open the submenu on the
// switch row, ArrowLeft closes it, Enter activates, Esc closes (handled
// by DesktopAgentApp's window-level listener alongside click-outside).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ExpandedLayout, Size } from "../lib/anchorGeometry";
import { deriveAvatarState } from "../lib/avatarState";
import { BERDY_CLIPS } from "../lib/berdyClips";
import { useAgentAvatar } from "../hooks/useAgentAvatar";
import type { AvatarMenuModel } from "../hooks/useAvatarMenu";
import type { AgentInfo } from "../hooks/useSession";
import { AvatarView } from "./AvatarView";

export const MENU_WIDTH = 190;
export const SUBMENU_WIDTH = 240;
const ROW_HEIGHT = 28;
const MENU_PADDING = 6;
const SEPARATOR_HEIGHT = 9; // 1px rule + margins
const SUBMENU_GAP = 4;
const PREVIEW_SIZE = 18;

/**
 * Overlay region the menu needs: wide enough for the root menu PLUS the
 * submenu beside it (the window frame is fixed while the menu is open;
 * the submenu must already fit). anchorGeometry adds the shadow margin.
 */
export function menuOverlaySize(args: {
  agentSelector: boolean;
  agentCount: number;
}): Size {
  const mainRows = args.agentSelector ? 3 : 2;
  const mainHeight =
    MENU_PADDING * 2 +
    mainRows * ROW_HEIGHT +
    (args.agentSelector ? SEPARATOR_HEIGHT : 0);
  if (!args.agentSelector) {
    return { width: MENU_WIDTH, height: mainHeight };
  }
  // Berd row + agent rows (or the one empty-state row).
  const subRows = 1 + Math.max(args.agentCount, 1);
  const subHeight = MENU_PADDING * 2 + subRows * ROW_HEIGHT;
  return {
    width: MENU_WIDTH + SUBMENU_GAP + SUBMENU_WIDTH,
    height: Math.max(mainHeight, subHeight),
  };
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** Berd's submenu preview: a static first frame of the Berdy character
 *  (paused idle clip — no poster asset exists, and a tiny paused video
 *  renders its first frame). */
function BerdPreview() {
  return (
    <video
      className="menu-preview"
      src={BERDY_CLIPS.idle1.file}
      muted
      playsInline
      preload="auto"
      width={PREVIEW_SIZE}
      height={PREVIEW_SIZE}
    />
  );
}

const PREVIEW_STATE = deriveAvatarState({
  hovering: false,
  expanded: false,
  connected: true,
  activity: "none",
});

function AgentPreview({ agentId }: { agentId: string }) {
  const avatar = useAgentAvatar(agentId);
  return (
    <span className="menu-preview">
      <AvatarView
        choice={avatar.choice}
        state={PREVIEW_STATE}
        size={PREVIEW_SIZE}
      />
    </span>
  );
}

export function AvatarMenu({
  layout,
  agentSelector,
  model,
  onSelectAgent,
  onSelectFresh,
  onSettings,
  onHide,
}: {
  layout: ExpandedLayout;
  agentSelector: boolean;
  model: AvatarMenuModel;
  onSelectAgent(agent: AgentInfo): void;
  onSelectFresh(): void;
  onSettings(): void;
  onHide(): void;
}) {
  const { t } = useTranslation("desktop-agent");
  const [submenuOpen, setSubmenuOpen] = useState(false);
  // Highlight index over the ROOT rows (switch?, settings, hide) or the
  // SUBMENU rows (Berd, agents...) depending on which menu is focused.
  const [highlight, setHighlight] = useState<number | null>(null);
  const [subHighlight, setSubHighlight] = useState<number | null>(null);

  const rootItems = useMemo(
    () =>
      agentSelector
        ? (["switch", "settings", "hide"] as const)
        : (["settings", "hide"] as const),
    [agentSelector],
  );

  // Submenu interactive rows: Berd first, then the agents. The empty-
  // state row is non-interactive and excluded.
  const subItems = useMemo<("fresh" | AgentInfo)[]>(
    () => ["fresh" as const, ...model.agents],
    [model.agents],
  );

  const activateRoot = (item: (typeof rootItems)[number]) => {
    if (item === "switch") {
      setSubmenuOpen(true);
      setSubHighlight(0);
      return;
    }
    if (item === "settings") onSettings();
    else onHide();
  };

  const activateSub = (item: "fresh" | AgentInfo) => {
    if (item === "fresh") onSelectFresh();
    else onSelectAgent(item);
  };

  const activateRef = useRef({ activateRoot, activateSub });
  activateRef.current = { activateRoot, activateSub };

  const stateRef = useRef({
    rootItems,
    subItems,
    submenuOpen,
    highlight,
    subHighlight,
  });
  stateRef.current = {
    rootItems,
    subItems,
    submenuOpen,
    highlight,
    subHighlight,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      const move = (index: number | null, delta: number, length: number) =>
        index === null
          ? delta > 0
            ? 0
            : length - 1
          : (index + delta + length) % length;
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp": {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          if (s.submenuOpen) {
            setSubHighlight(move(s.subHighlight, delta, s.subItems.length));
          } else {
            setHighlight(move(s.highlight, delta, s.rootItems.length));
          }
          break;
        }
        case "ArrowRight":
          if (!s.submenuOpen && s.rootItems[s.highlight ?? -1] === "switch") {
            setSubmenuOpen(true);
            setSubHighlight(0);
          }
          break;
        case "ArrowLeft":
          if (s.submenuOpen) {
            setSubmenuOpen(false);
            setSubHighlight(null);
          }
          break;
        case "Enter": {
          if (s.submenuOpen) {
            const item = s.subItems[s.subHighlight ?? -1];
            if (item !== undefined) activateRef.current.activateSub(item);
          } else {
            const item = s.rootItems[s.highlight ?? -1];
            if (item !== undefined) activateRef.current.activateRoot(item);
          }
          break;
        }
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Geometry within the overlay region (origin = popoverRect top-left).
  const regionW = layout.popoverRect.width;
  const regionH = layout.popoverRect.height;
  const mainHeight =
    MENU_PADDING * 2 +
    rootItems.length * ROW_HEIGHT +
    (agentSelector ? SEPARATOR_HEIGHT : 0);
  const avatarCenterX =
    layout.avatarRect.x + layout.avatarRect.width / 2 - layout.popoverRect.x;
  const rootX = clamp(avatarCenterX - MENU_WIDTH / 2, 0, regionW - MENU_WIDTH);
  // Hug the avatar edge: bottom-aligned when the menu opens above it.
  const rootY = layout.popoverAbove ? regionH - mainHeight : 0;
  const switchRowTop = rootY + MENU_PADDING;
  const subHeight =
    MENU_PADDING * 2 + Math.max(subItems.length, 2) * ROW_HEIGHT;
  const subFitsRight =
    rootX + MENU_WIDTH + SUBMENU_GAP + SUBMENU_WIDTH <= regionW;
  const subX = subFitsRight
    ? rootX + MENU_WIDTH + SUBMENU_GAP
    : Math.max(0, rootX - SUBMENU_GAP - SUBMENU_WIDTH);
  const subY = clamp(switchRowTop - MENU_PADDING, 0, regionH - subHeight);

  const row = (args: {
    key: string;
    className?: string;
    highlighted: boolean;
    onHover(): void;
    onClick(): void;
    children: React.ReactNode;
  }) => (
    <button
      key={args.key}
      type="button"
      className={`menu-row focus-override ${args.className ?? ""} ${
        args.highlighted ? "highlighted" : ""
      }`}
      onPointerEnter={args.onHover}
      onClick={args.onClick}
    >
      {args.children}
    </button>
  );

  return (
    <div className="avatar-menu-region">
      <div
        className="menu-card avatar-menu"
        style={{ left: rootX, top: rootY, width: MENU_WIDTH }}
        role="menu"
      >
        {agentSelector && (
          <>
            {row({
              key: "switch",
              highlighted: highlight === 0,
              onHover: () => {
                setHighlight(0);
                setSubmenuOpen(true);
              },
              onClick: () => {
                setSubmenuOpen(true);
                setSubHighlight(0);
              },
              children: (
                <>
                  <span className="menu-label">{t("menu.switchAgent")}</span>
                  <span className="menu-chevron">›</span>
                </>
              ),
            })}
            <div className="menu-separator" />
          </>
        )}
        {row({
          key: "settings",
          highlighted: highlight === rootItems.indexOf("settings"),
          onHover: () => {
            setHighlight(rootItems.indexOf("settings"));
            setSubmenuOpen(false);
          },
          onClick: onSettings,
          children: <span className="menu-label">{t("menu.settings")}</span>,
        })}
        {row({
          key: "hide",
          highlighted: highlight === rootItems.indexOf("hide"),
          onHover: () => {
            setHighlight(rootItems.indexOf("hide"));
            setSubmenuOpen(false);
          },
          onClick: onHide,
          children: <span className="menu-label">{t("menu.dismiss")}</span>,
        })}
      </div>
      {agentSelector && submenuOpen && (
        <div
          className="menu-card avatar-submenu"
          style={{ left: subX, top: subY, width: SUBMENU_WIDTH }}
          role="menu"
        >
          {row({
            key: "fresh",
            highlighted: subHighlight === 0,
            onHover: () => setSubHighlight(0),
            onClick: onSelectFresh,
            children: (
              <>
                <BerdPreview />
                <span className="menu-label">{t("menu.fresh")}</span>
                {model.checkedFresh && <span className="menu-check">✓</span>}
              </>
            ),
          })}
          {model.agents.map((agent, i) =>
            row({
              key: agent.agentId,
              highlighted: subHighlight === i + 1,
              onHover: () => setSubHighlight(i + 1),
              onClick: () => onSelectAgent(agent),
              children: (
                <>
                  <AgentPreview agentId={agent.agentId} />
                  <span className="menu-label">{agent.name}</span>
                  {model.checkedAgentId === agent.agentId && (
                    <span className="menu-check">✓</span>
                  )}
                </>
              ),
            }),
          )}
          {model.agents.length === 0 && (
            <div className="menu-empty">{t("menu.empty")}</div>
          )}
        </div>
      )}
    </div>
  );
}
