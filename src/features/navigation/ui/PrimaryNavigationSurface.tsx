import {
  forwardRef,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { IconArrowLeft, IconServer } from "@tabler/icons-react";
import { ArrowUpCircle } from "lucide-react";
import type { AppView } from "@/app/AppShell";
import { PaneSurface } from "@/app/layout/panes/paneChrome";
import {
  DEFAULT_SETTINGS_SECTION,
  type SETTINGS_SECTIONS,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import { cn } from "@/shared/lib/cn";
import {
  SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS,
  SIDEBAR_PRIMARY_NAV_TOP_INSET_CLASS,
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
  renderInlineSessionList?: () => ReactNode;
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
  const { t } = useTranslation(["sidebar", "settings"]);
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
      <div
        className={cn("flex-shrink-0", SIDEBAR_PRIMARY_NAV_TOP_INSET_CLASS)}
        aria-hidden="true"
      />

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
            <div className="relative z-10 space-y-0">
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

            {!navCollapsed && <SidebarPinnedSection />}

            {renderInlineSessionList?.()}
          </nav>
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
          <div className="mt-1 flex h-7 flex-shrink-0 items-center px-1.5">
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
