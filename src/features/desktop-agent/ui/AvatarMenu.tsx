// Custom webview context menu for the avatar — replaces the native
// NSMenu so rows can carry avatar previews and the chrome can match the
// popover's dark glass. The collapsed panel window is avatar-sized, so
// DesktopAgentApp grows the window first ("menu" panel mode, same
// anti-blink path as the chat popover) and renders this component inside
// the computed overlay region; this component only positions the menu
// card (and the "Switch agent" submenu) WITHIN that region.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
export const SUBMENU_GAP = 8;
const PREVIEW_SIZE = 18;
const SUBMENU_MAX_ROWS = 8;
const SUBMENU_CLOSE_DELAY_MS = 150;
const MENU_BORDER_WIDTH = 1;

export interface AvatarMenuPlacement {
  regionSize: Size;
  root: { x: number; y: number; width: number; height: number };
  submenu: { x: number; y: number; width: number; height: number };
  submenuMaxHeight: number;
  submenuSide: "left" | "right";
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

function rootHeight(agentSelector: boolean): number {
  const rows = agentSelector ? 4 : 3;
  return (
    MENU_PADDING * 2 +
    rows * ROW_HEIGHT +
    (agentSelector ? SEPARATOR_HEIGHT : 0) +
    MENU_BORDER_WIDTH * 2
  );
}

function submenuNaturalHeight(agentCount: number): number {
  return (
    MENU_PADDING * 2 +
    (1 + Math.max(agentCount, 1)) * ROW_HEIGHT +
    MENU_BORDER_WIDTH * 2
  );
}

/**
 * Single source of truth for the menu overlay geometry. The native window
 * must be sized before render, so this pure function is shared by
 * menuOverlaySize() and AvatarMenu. The region is wide enough for root +
 * submenu, but the root hugs the avatar edge while the submenu opens away
 * from the avatar/toward available screen space.
 */
export function computeAvatarMenuPlacement(args: {
  agentSelector: boolean;
  agentCount: number;
  visibleHeight?: number;
  openSubmenu?: boolean;
  regionWidth?: number;
  regionHeight?: number;
  avatarCenterX?: number;
  popoverAbove?: boolean;
}): AvatarMenuPlacement {
  const mainHeight = rootHeight(args.agentSelector);
  const rawSubHeight = submenuNaturalHeight(args.agentCount);
  const maxScrollableSubHeight =
    MENU_PADDING * 2 + SUBMENU_MAX_ROWS * ROW_HEIGHT + MENU_BORDER_WIDTH * 2;
  const visibleHeight = args.visibleHeight ?? Number.POSITIVE_INFINITY;
  const submenuMaxHeight = Math.max(
    MENU_PADDING * 2 + ROW_HEIGHT + MENU_BORDER_WIDTH * 2,
    Math.min(rawSubHeight, maxScrollableSubHeight, visibleHeight),
  );
  const subHeight = args.agentSelector ? submenuMaxHeight : 0;
  const openSubmenu = args.agentSelector && args.openSubmenu !== false;
  const width = args.agentSelector
    ? MENU_WIDTH + SUBMENU_GAP + SUBMENU_WIDTH
    : MENU_WIDTH;
  const height = Math.max(mainHeight, openSubmenu ? subHeight : 0);
  const regionWidth = args.regionWidth ?? width;
  const regionHeight = args.regionHeight ?? height;
  const submenuSide =
    args.avatarCenterX !== undefined && args.avatarCenterX < regionWidth / 2
      ? "right"
      : "left";
  const rootX = clamp(
    args.agentSelector && submenuSide === "left" ? regionWidth - MENU_WIDTH : 0,
    0,
    regionWidth - MENU_WIDTH,
  );
  const rootY = clamp(
    args.popoverAbove ? regionHeight - mainHeight : 0,
    0,
    regionHeight - mainHeight,
  );
  const subX =
    submenuSide === "right"
      ? rootX + MENU_WIDTH + SUBMENU_GAP
      : rootX - SUBMENU_GAP - SUBMENU_WIDTH;
  const subY = clamp(rootY, 0, regionHeight - subHeight);
  return {
    regionSize: { width, height },
    root: { x: rootX, y: rootY, width: MENU_WIDTH, height: mainHeight },
    submenu: { x: subX, y: subY, width: SUBMENU_WIDTH, height: subHeight },
    submenuMaxHeight,
    submenuSide,
  };
}

/** Overlay region the menu needs before it is rendered. */
export function menuOverlaySize(args: {
  agentSelector: boolean;
  agentCount: number;
  visibleHeight?: number;
}): Size {
  return computeAvatarMenuPlacement({
    agentSelector: args.agentSelector,
    agentCount: args.agentCount,
    visibleHeight: args.visibleHeight,
  }).regionSize;
}

/** Berd's submenu preview: a static first frame of the Berdy character. */
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
  onNewChat,
  onSelectAgent,
  onSelectFresh,
  onSettings,
  onTurnOff,
  onClose,
}: {
  layout: ExpandedLayout;
  agentSelector: boolean;
  model: AvatarMenuModel;
  onNewChat(): void;
  onSelectAgent(agent: AgentInfo): void;
  onSelectFresh(): void;
  onSettings(): void;
  onTurnOff(): void;
  onClose?(): void;
}) {
  const { t } = useTranslation("desktop-agent");
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(0);
  const [subHighlight, setSubHighlight] = useState<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const rootRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const subRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const rootItems = useMemo<
    Array<"newChat" | "switch" | "settings" | "turnOff">
  >(
    () =>
      agentSelector
        ? ["newChat", "switch", "settings", "turnOff"]
        : ["newChat", "settings", "turnOff"],
    [agentSelector],
  );
  const subItems = useMemo<("fresh" | AgentInfo)[]>(
    () => ["fresh" as const, ...model.agents],
    [model.agents],
  );

  const regionW = layout.popoverRect.width;
  const regionH = layout.popoverRect.height;
  const avatarCenterX =
    layout.avatarRect.x + layout.avatarRect.width / 2 - layout.popoverRect.x;
  const placement = computeAvatarMenuPlacement({
    agentSelector,
    agentCount: model.agents.length,
    visibleHeight: regionH,
    openSubmenu: submenuOpen,
    regionWidth: regionW,
    regionHeight: regionH,
    avatarCenterX,
    popoverAbove: layout.popoverAbove,
  });

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const openSubmenu = useCallback(() => {
    clearCloseTimer();
    setSubmenuOpen(true);
  }, [clearCloseTimer]);
  const scheduleSubmenuClose = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setSubmenuOpen(false);
      setSubHighlight(null);
    }, SUBMENU_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  useEffect(() => {
    if (highlight !== null) rootRefs.current[highlight]?.focus();
  }, [highlight]);

  useEffect(() => {
    if (subHighlight !== null) subRefs.current[subHighlight]?.focus();
  }, [subHighlight]);

  const activateRoot = useCallback(
    (item: (typeof rootItems)[number]) => {
      if (item === "newChat") {
        onNewChat();
        return;
      }
      if (item === "switch") {
        openSubmenu();
        setSubHighlight(0);
        return;
      }
      if (item === "settings") onSettings();
      else onTurnOff();
    },
    [onTurnOff, onNewChat, onSettings, openSubmenu],
  );

  useEffect(() => {
    const move = (index: number | null, delta: number, length: number) =>
      index === null
        ? delta > 0
          ? 0
          : length - 1
        : (index + delta + length) % length;
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp": {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          if (submenuOpen)
            setSubHighlight((i) => move(i, delta, subItems.length));
          else setHighlight((i) => move(i, delta, rootItems.length));
          e.preventDefault();
          break;
        }
        case "ArrowRight":
          if (!submenuOpen && rootItems[highlight ?? -1] === "switch") {
            openSubmenu();
            setSubHighlight(0);
            e.preventDefault();
          }
          break;
        case "ArrowLeft":
          if (submenuOpen) {
            const switchIndex = rootItems.indexOf("switch");
            setSubmenuOpen(false);
            setSubHighlight(null);
            setHighlight(switchIndex);
            rootRefs.current[switchIndex]?.focus();
            e.preventDefault();
          }
          break;
        case "Escape":
          onClose?.();
          e.preventDefault();
          break;
        case "Enter":
          if (e.repeat) break;
          if (submenuOpen) {
            const item = subItems[subHighlight ?? -1];
            if (item !== undefined) {
              if (item === "fresh") onSelectFresh();
              else onSelectAgent(item);
              e.preventDefault();
            }
          } else {
            const item = rootItems[highlight ?? -1];
            if (item !== undefined) {
              activateRoot(item);
              e.preventDefault();
            }
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    highlight,
    activateRoot,
    onSelectAgent,
    onSelectFresh,
    onClose,
    openSubmenu,
    rootItems,
    subHighlight,
    subItems,
    submenuOpen,
  ]);

  const row = (args: {
    key: string;
    className?: string;
    highlighted: boolean;
    menu: "root" | "sub";
    index: number;
    onHover(): void;
    onClick(): void;
    children: React.ReactNode;
  }) => (
    <button
      key={args.key}
      ref={(node) => {
        const refs = args.menu === "root" ? rootRefs.current : subRefs.current;
        refs[args.index] = node;
      }}
      type="button"
      className={`menu-row focus-override ${args.className ?? ""} ${
        args.highlighted ? "highlighted" : ""
      }`}
      onPointerEnter={args.onHover}
      onClick={args.onClick}
      role="menuitem"
      tabIndex={args.highlighted ? 0 : -1}
    >
      {args.children}
    </button>
  );

  return (
    <div className="avatar-menu-region">
      <div
        className="menu-card avatar-menu"
        style={{
          left: placement.root.x,
          top: placement.root.y,
          width: MENU_WIDTH,
        }}
        role="menu"
        onPointerEnter={clearCloseTimer}
      >
        {(() => {
          const index = rootItems.indexOf("newChat");
          return row({
            key: "newChat",
            menu: "root",
            index,
            highlighted: highlight === index,
            onHover: () => {
              setHighlight(index);
              scheduleSubmenuClose();
            },
            onClick: onNewChat,
            children: <span className="menu-label">{t("menu.newChat")}</span>,
          });
        })()}
        {agentSelector && (
          <>
            {(() => {
              const index = rootItems.indexOf("switch");
              return row({
                key: "switch",
                menu: "root",
                index,
                highlighted: highlight === index,
                onHover: () => {
                  setHighlight(index);
                  openSubmenu();
                },
                onClick: () => {
                  openSubmenu();
                  setSubHighlight(0);
                },
                children: (
                  <>
                    <span className="menu-label">{t("menu.switchAgent")}</span>
                    <span className="menu-chevron">›</span>
                  </>
                ),
              });
            })()}
            <div className="menu-separator" />
          </>
        )}
        {(() => {
          const index = rootItems.indexOf("settings");
          return row({
            key: "settings",
            menu: "root",
            index,
            highlighted: highlight === index,
            onHover: () => {
              setHighlight(index);
              scheduleSubmenuClose();
            },
            onClick: onSettings,
            children: <span className="menu-label">{t("menu.settings")}</span>,
          });
        })()}
        {(() => {
          const index = rootItems.indexOf("turnOff");
          return row({
            key: "turnOff",
            menu: "root",
            index,
            highlighted: highlight === index,
            onHover: () => {
              setHighlight(index);
              scheduleSubmenuClose();
            },
            onClick: onTurnOff,
            children: <span className="menu-label">{t("menu.turnOff")}</span>,
          });
        })()}
      </div>
      {agentSelector && submenuOpen && (
        <div
          className="menu-card avatar-submenu"
          style={{
            left: placement.submenu.x,
            top: placement.submenu.y,
            width: SUBMENU_WIDTH,
            maxHeight: placement.submenuMaxHeight,
          }}
          role="menu"
          onPointerEnter={clearCloseTimer}
          onPointerLeave={scheduleSubmenuClose}
        >
          {row({
            key: "fresh",
            menu: "sub",
            index: 0,
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
              menu: "sub",
              index: i + 1,
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
