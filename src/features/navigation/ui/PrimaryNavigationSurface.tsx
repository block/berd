import {
  forwardRef,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  IconArrowLeft,
  IconSearch,
  IconServer,
  IconX,
} from "@tabler/icons-react";
import { ArrowUpCircle } from "lucide-react";
import type { AppView } from "@/app/AppShell";
import { PaneSurface } from "@/app/layout/panes/paneChrome";
import {
  DEFAULT_SETTINGS_SECTION,
  type SETTINGS_SECTIONS,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS,
  SIDEBAR_SECTION_DIVIDER_INSET_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { SidebarNavItem } from "./SidebarNavItem";
import {
  SidebarNavAgentsIcon,
  SidebarNavAutomationsIcon,
  SidebarNavHomeIcon,
  SidebarNavSettingsIcon,
  SidebarNavSkillsIcon,
} from "./sidebarNavIcons";
import { SidebarPinnedSection } from "./SidebarPinnedSection";

type SidebarNavItemIcon = NonNullable<
  ComponentProps<typeof SidebarNavItem>["icon"]
>;

interface PrimaryNavigationSurfaceProps {
  activeSettingsSection?: SectionId;
  activeView?: AppView;
  agentUpdatesAvailable: boolean;
  bottomMaskStyle: CSSProperties;
  topMaskStyle: CSSProperties;
  bothEdgeMaskStyle: CSSProperties;
  elevatedShadow?: boolean;
  isSecondarySurface: boolean;
  labelTransition: string;
  mainNavRef: Ref<HTMLElement>;
  navCollapsed: boolean;
  navLabelVisible: boolean;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  onNavigate?: (view: AppView) => void;
  onSettingsBack?: () => void;
  onSettingsClick?: () => void;
  onSettingsSectionChange?: (section: SectionId) => void;
  renderInlineSessionList?: (searchQuery: string) => ReactNode;
  secondaryNavRef: Ref<HTMLElement>;
  settingsSections: readonly (typeof SETTINGS_SECTIONS)[number][];
  showBottomMask: boolean;
  showTopMask: boolean;
  showAutomationsSurface: boolean;
  showBuilderbotSurface: boolean;
  showSecondaryBottomMask: boolean;
  width: number;
}

export const PrimaryNavigationSurface = forwardRef<
  HTMLDivElement,
  PrimaryNavigationSurfaceProps
>(function PrimaryNavigationSurface(
  {
    activeSettingsSection = DEFAULT_SETTINGS_SECTION,
    activeView = "home",
    agentUpdatesAvailable,
    bottomMaskStyle,
    topMaskStyle,
    bothEdgeMaskStyle,
    elevatedShadow = false,
    isSecondarySurface,
    labelTransition,
    mainNavRef,
    navCollapsed,
    navLabelVisible,
    onKeyDown,
    onNavigate,
    onSettingsBack,
    onSettingsClick,
    onSettingsSectionChange,
    renderInlineSessionList,
    secondaryNavRef,
    settingsSections,
    showBottomMask,
    showTopMask,
    showAutomationsSurface,
    showBuilderbotSurface,
    showSecondaryBottomMask,
    width,
  },
  ref,
) {
  const { t } = useTranslation(["sidebar", "common", "settings"]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchExpanded, setSearchExpanded] = useState(!navCollapsed);
  const [searchQuery, setSearchQuery] = useState("");
  const expandSearch = () => {
    setSearchExpanded(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  useEffect(() => {
    if (navCollapsed) {
      setSearchQuery("");
      return;
    }
    setSearchExpanded(true);
  }, [navCollapsed]);
  useEffect(() => {
    const focusSearch = () => {
      setSearchExpanded(true);
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("goose:focus-nav-search", focusSearch);
    return () =>
      window.removeEventListener("goose:focus-nav-search", focusSearch);
  }, []);
  const mainNavItems: readonly {
    id: AppView;
    label: string;
    icon: SidebarNavItemIcon;
  }[] = [
    { id: "agents", label: t("navigation.agents"), icon: SidebarNavAgentsIcon },
    { id: "skills", label: t("navigation.skills"), icon: SidebarNavSkillsIcon },
    ...(showAutomationsSurface
      ? [
          {
            id: "automations" as const,
            label: t("navigation.automations"),
            icon: SidebarNavAutomationsIcon,
          },
        ]
      : []),
    ...(showBuilderbotSurface
      ? [
          {
            id: "builderbot" as const,
            label: t("navigation.builderbot"),
            icon: IconServer,
          },
        ]
      : []),
  ];

  return (
    <PaneSurface
      ref={ref}
      testId="sidebar-primary-nav-panel"
      className={cn(
        "transition-[height,box-shadow] duration-200 ease-out",
        elevatedShadow && SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS,
      )}
      fullHeight
      width={width}
    >
      <div className="flex-shrink-0 pt-1.5" aria-hidden="true" />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "absolute inset-0 flex flex-col transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
            isSecondarySurface
              ? "pointer-events-none -translate-x-full opacity-0"
              : "translate-x-0 opacity-100",
          )}
          inert={isSecondarySurface ? true : undefined}
          aria-hidden={isSecondarySurface}
        >
          <div className="mb-1 flex h-7 flex-shrink-0 items-center px-1.5">
            {navCollapsed ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("search.jumpToChat")}
                tooltip={t("search.jumpToChat")}
                onClick={expandSearch}
              >
                <IconSearch aria-hidden="true" className="!size-4" />
              </Button>
            ) : searchExpanded ? (
              <div className="group relative block w-full overflow-hidden rounded-sm">
                <IconSearch
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground group-focus-within:text-muted-foreground"
                />
                <input
                  ref={searchInputRef}
                  type="search"
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="none"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("search.jumpToChat")}
                  aria-label={t("search.jumpToChat")}
                  className="h-7 w-full appearance-none rounded-sm border-0 bg-muted/40 pl-9 pr-8 text-sm font-normal text-muted-foreground/50 shadow-none outline-none ring-0 transition-colors placeholder:text-muted-foreground/50 hover:bg-muted/60 hover:text-muted-foreground focus:bg-muted/60 focus:text-muted-foreground focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 [&::-webkit-search-cancel-button]:appearance-none"
                />
                {searchQuery && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("common:actions.clear")}
                    title={t("common:actions.clear")}
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                    onClick={() => {
                      setSearchQuery("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <IconX aria-hidden="true" />
                  </Button>
                )}
              </div>
            ) : null}
          </div>
          <nav
            ref={mainNavRef}
            onKeyDown={onKeyDown}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 py-1 pb-1 scrollbar-none"
            style={
              showTopMask && showBottomMask
                ? bothEdgeMaskStyle
                : showTopMask
                  ? topMaskStyle
                  : showBottomMask
                    ? bottomMaskStyle
                    : undefined
            }
            aria-label={t("navigation.main")}
          >
            <div
              className={cn("relative z-10 space-y-0", searchQuery && "hidden")}
            >
              <SidebarNavItem
                testId="nav-home"
                navId="home"
                icon={SidebarNavHomeIcon}
                label={t("navigation.home")}
                collapsed={navCollapsed}
                labelTransition={labelTransition}
                labelVisible={navLabelVisible}
                isActive={activeView === "home"}
                onClick={() => onNavigate?.("home")}
              />

              {mainNavItems.map((item) => {
                const isActive = activeView === item.id;
                return (
                  <SidebarNavItem
                    key={item.id}
                    navId={item.id}
                    icon={item.icon}
                    label={item.label}
                    collapsed={navCollapsed}
                    labelTransition={labelTransition}
                    labelVisible={navLabelVisible}
                    isActive={isActive}
                    onClick={() => onNavigate?.(item.id)}
                  />
                );
              })}
            </div>

            {!navCollapsed && !searchQuery && <SidebarPinnedSection />}

            {renderInlineSessionList?.(searchQuery)}
          </nav>
          {(!searchQuery || navCollapsed) && (
            <div className="flex-shrink-0 px-1.5 py-1.5">
              <div
                aria-hidden="true"
                className={cn(
                  "mb-1.5 h-px bg-border/70",
                  SIDEBAR_SECTION_DIVIDER_INSET_CLASS,
                )}
              />
              <SidebarNavItem
                testId="nav-settings"
                navId="settings"
                icon={SidebarNavSettingsIcon}
                label={t("settings:title")}
                collapsed={navCollapsed}
                labelTransition={labelTransition}
                labelVisible={navLabelVisible}
                isActive={activeView === "settings"}
                onClick={() => onSettingsClick?.()}
              />
            </div>
          )}
        </div>

        <div
          className={cn(
            "absolute inset-0 flex flex-col transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
            isSecondarySurface
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-full opacity-0",
          )}
          inert={!isSecondarySurface ? true : undefined}
          aria-hidden={!isSecondarySurface}
        >
          <div className="flex h-7 flex-shrink-0 items-center px-1.5">
            <SidebarNavItem
              icon={IconArrowLeft}
              label={t("actions.backToMainNavigation")}
              collapsed={navCollapsed}
              labelTransition={labelTransition}
              labelVisible={navLabelVisible}
              isActive={false}
              onClick={() => onSettingsBack?.()}
            />
          </div>
          <nav
            ref={secondaryNavRef}
            onKeyDown={onKeyDown}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 py-1 pb-1 scrollbar-none"
            style={showSecondaryBottomMask ? bottomMaskStyle : undefined}
            aria-label={t("settings:navigationLabel")}
          >
            <div className="space-y-0">
              {settingsSections.map((item) => {
                const showUpdate =
                  item.id === "providers" && agentUpdatesAvailable;
                return (
                  <SidebarNavItem
                    key={item.id}
                    navId={`settings-${item.id}`}
                    icon={item.icon}
                    label={t(`settings:${item.labelKey}`)}
                    collapsed={navCollapsed}
                    labelTransition={labelTransition}
                    labelVisible={navLabelVisible}
                    isActive={activeSettingsSection === item.id}
                    onClick={() => onSettingsSectionChange?.(item.id)}
                    trailingIcon={
                      showUpdate ? (
                        <ArrowUpCircle
                          aria-hidden="true"
                          className="size-3.5 text-warning"
                        />
                      ) : undefined
                    }
                    trailingLabel={
                      showUpdate
                        ? t("settings:nav.providersUpdateAvailable")
                        : undefined
                    }
                  />
                );
              })}
            </div>
          </nav>
        </div>
      </div>
    </PaneSurface>
  );
});
