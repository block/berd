import {
  forwardRef,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { IconArrowLeft, IconPalette, IconServer } from "@tabler/icons-react";
import { ArrowUpCircle, ChevronLeft, ChevronRight } from "lucide-react";
import type { AppView } from "@/app/AppShell";
import { PaneSurface } from "@/app/layout/panes/paneChrome";
import {
  DEFAULT_DESIGN_SYSTEM_SECTION,
  DESIGN_SYSTEM_COMPONENT_SECTIONS,
  DESIGN_SYSTEM_CORE_SECTIONS,
  DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS,
  type DesignSystemSection,
} from "@/features/design-system/ui/designSystemSections";
import {
  DEFAULT_SETTINGS_SECTION,
  type SETTINGS_SECTIONS,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
  SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS,
  SIDEBAR_NAV_ROW_SPACING_CLASS,
  SIDEBAR_NAV_TEXT_CLASS,
  SIDEBAR_PANEL_ELEVATED_HOVER_SHADOW_CLASS,
  SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS,
} from "@/shared/ui/sidebar-tokens";
import { Switch } from "@/shared/ui/switch";
import { SidebarNavItem } from "./SidebarNavItem";
import {
  SidebarNavAgentsIcon,
  SidebarNavAutomationsIcon,
  SidebarNavChatsIcon,
  SidebarNavHomeIcon,
  SidebarNavSettingsIcon,
  SidebarNavSkillsIcon,
} from "./sidebarNavIcons";
import { SidebarPinnedSection } from "./SidebarPinnedSection";

type SidebarNavItemIcon = NonNullable<
  ComponentProps<typeof SidebarNavItem>["icon"]
>;

function SidebarInspectorToggleNavItem({
  checked,
  collapsed,
  label,
  labelTransition,
  labelTransitionDelay,
  labelVisible,
  onCheckedChange,
  switchLabel,
}: {
  checked: boolean;
  collapsed: boolean;
  label: string;
  labelTransition: string;
  labelTransitionDelay?: string;
  labelVisible: boolean;
  onCheckedChange?: (checked: boolean) => void;
  switchLabel: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center rounded-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
        SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
        SIDEBAR_NAV_TEXT_CLASS,
        collapsed
          ? "justify-center px-3 py-2"
          : cn("justify-between", SIDEBAR_NAV_ROW_SPACING_CLASS),
      )}
      title={collapsed ? label : undefined}
    >
      <span
        className={cn(
          "min-w-0 whitespace-nowrap",
          labelTransition,
          labelVisible ? "opacity-100 w-auto" : "opacity-0 w-0 overflow-hidden",
        )}
        style={{ transitionDelay: labelTransitionDelay }}
      >
        {label}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={switchLabel}
      />
    </div>
  );
}

interface PrimaryNavigationSurfaceProps {
  activeDesignSystemSection?: DesignSystemSection;
  activeSettingsSection?: SectionId;
  activeView?: AppView;
  agentUpdatesAvailable: boolean;
  bottomMaskStyle: CSSProperties;
  detachable: boolean;
  designSystemInspectorVisible?: boolean;
  elevatedShadow?: boolean;
  fullHeight: boolean;
  isSecondarySurface: boolean;
  isSettingsSurface: boolean;
  labelTransition: string;
  mainNavRef: Ref<HTMLElement>;
  navCollapsed: boolean;
  navLabelVisible: boolean;
  navPanelCompact: boolean;
  onDesignSystemBack?: () => void;
  onDesignSystemInspectorVisibleChange?: (visible: boolean) => void;
  onDesignSystemSectionChange?: (section: DesignSystemSection) => void;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  onNavigate?: (view: AppView) => void;
  onPrimaryNavWidthToggle: () => void;
  onSettingsBack?: () => void;
  onSettingsClick?: () => void;
  onSettingsSectionChange?: (section: SectionId) => void;
  renderInlineSessionList?: () => ReactNode;
  renderPrimaryNavResizeRail?: () => ReactNode;
  secondaryNavRef: Ref<HTMLElement>;
  settingsSections: readonly (typeof SETTINGS_SECTIONS)[number][];
  showBottomMask: boolean;
  showAutomationsSurface: boolean;
  showBuilderbotSurface: boolean;
  showDesignSystemSettingsItem: boolean;
  showPrimaryNavWidthToggle: boolean;
  showSecondaryBottomMask: boolean;
  stackedDetachedLayout: boolean;
  width: number;
}

export const PrimaryNavigationSurface = forwardRef<
  HTMLDivElement,
  PrimaryNavigationSurfaceProps
>(function PrimaryNavigationSurface(
  {
    activeDesignSystemSection = DEFAULT_DESIGN_SYSTEM_SECTION,
    activeSettingsSection = DEFAULT_SETTINGS_SECTION,
    activeView = "home",
    agentUpdatesAvailable,
    bottomMaskStyle,
    detachable,
    designSystemInspectorVisible,
    elevatedShadow = false,
    fullHeight,
    isSecondarySurface,
    isSettingsSurface,
    labelTransition,
    mainNavRef,
    navCollapsed,
    navLabelVisible,
    navPanelCompact,
    onDesignSystemBack,
    onDesignSystemInspectorVisibleChange,
    onDesignSystemSectionChange,
    onKeyDown,
    onNavigate,
    onPrimaryNavWidthToggle,
    onSettingsBack,
    onSettingsClick,
    onSettingsSectionChange,
    renderInlineSessionList,
    renderPrimaryNavResizeRail,
    secondaryNavRef,
    settingsSections,
    showBottomMask,
    showAutomationsSurface,
    showBuilderbotSurface,
    showDesignSystemSettingsItem,
    showPrimaryNavWidthToggle,
    showSecondaryBottomMask,
    stackedDetachedLayout,
    width,
  },
  ref,
) {
  const { t } = useTranslation(["sidebar", "common", "settings"]);
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
    {
      id: "session-history",
      label: t("navigation.sessionHistory"),
      icon: SidebarNavChatsIcon,
    },
  ];

  const primaryNavWidthToggleLabel = navPanelCompact
    ? t("actions.expandNavigationPanel")
    : t("actions.collapseNavigationPanel");
  const PrimaryNavWidthToggleIcon = navPanelCompact
    ? ChevronRight
    : ChevronLeft;

  return (
    <PaneSurface
      ref={ref}
      testId="sidebar-primary-nav-panel"
      className={cn(
        "transition-[height,box-shadow] duration-200 ease-out",
        detachable
          ? SIDEBAR_PANEL_ELEVATED_HOVER_SHADOW_CLASS
          : elevatedShadow && SIDEBAR_PANEL_ELEVATED_SHADOW_CLASS,
        stackedDetachedLayout && isSecondarySurface && "max-h-full",
      )}
      fullHeight={fullHeight}
      width={width}
    >
      {/* The goose home affordance now lives in the TopBar (left of the
          panel toggle) so it survives when the panel is collapsed. */}
      <div className="flex-shrink-0 pt-1.5" aria-hidden="true" />

      <div
        className={cn(
          "relative",
          stackedDetachedLayout && isSecondarySurface
            ? "min-h-0 flex-1 overflow-hidden"
            : stackedDetachedLayout
              ? "flex-none overflow-visible"
              : "flex-1 min-h-0 overflow-hidden",
        )}
      >
        <div
          className={cn(
            stackedDetachedLayout
              ? "flex flex-col"
              : "absolute inset-0 flex flex-col transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
            stackedDetachedLayout && isSecondarySurface && "hidden",
            !stackedDetachedLayout &&
              (isSecondarySurface
                ? "pointer-events-none -translate-x-full opacity-0"
                : "translate-x-0 opacity-100"),
          )}
          inert={isSecondarySurface ? true : undefined}
          aria-hidden={isSecondarySurface}
        >
          <nav
            ref={mainNavRef}
            onKeyDown={onKeyDown}
            className={cn(
              "min-h-0 overflow-x-hidden px-2.5 py-1 pb-1 scrollbar-none",
              stackedDetachedLayout
                ? "flex-none overflow-y-visible"
                : "flex-1 overflow-y-auto",
            )}
            style={showBottomMask ? bottomMaskStyle : undefined}
            aria-label={t("navigation.main")}
          >
            <div className="relative z-10 space-y-0.5">
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

            {!navCollapsed && <SidebarPinnedSection />}

            {renderInlineSessionList?.()}
          </nav>
        </div>

        <div
          className={cn(
            stackedDetachedLayout
              ? "flex flex-col"
              : "absolute inset-0 flex flex-col transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
            stackedDetachedLayout && !isSecondarySurface && "hidden",
            !stackedDetachedLayout &&
              (isSecondarySurface
                ? "translate-x-0 opacity-100"
                : "pointer-events-none translate-x-full opacity-0"),
          )}
          inert={!isSecondarySurface ? true : undefined}
          aria-hidden={!isSecondarySurface}
        >
          <nav
            ref={secondaryNavRef}
            onKeyDown={onKeyDown}
            className={cn(
              "min-h-0 overflow-x-hidden px-2.5 py-1 pb-12 scrollbar-none",
              stackedDetachedLayout && !isSecondarySurface
                ? "flex-none overflow-y-visible"
                : "flex-1 overflow-y-auto",
            )}
            style={showSecondaryBottomMask ? bottomMaskStyle : undefined}
            aria-label={
              isSettingsSurface
                ? t("settings:navigationLabel")
                : "Design system navigation"
            }
          >
            <div className="space-y-0.5">
              {isSettingsSurface ? (
                <>
                  {settingsSections.map((item) => {
                    const showUpdate =
                      item.id === "providers" && agentUpdatesAvailable;
                    return (
                      <SidebarNavItem
                        key={item.id}
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
                  {showDesignSystemSettingsItem && (
                    <SidebarNavItem
                      icon={IconPalette}
                      label={t("settings:nav.designSystem")}
                      collapsed={navCollapsed}
                      labelTransition={labelTransition}
                      labelVisible={navLabelVisible}
                      isActive={false}
                      onClick={() => onNavigate?.("design-system")}
                    />
                  )}
                </>
              ) : (
                <>
                  <SidebarInspectorToggleNavItem
                    checked={Boolean(designSystemInspectorVisible)}
                    collapsed={navCollapsed}
                    label={t("designSystem.inspector")}
                    labelTransition={labelTransition}
                    labelVisible={navLabelVisible}
                    onCheckedChange={onDesignSystemInspectorVisibleChange}
                    switchLabel={t("designSystem.showInspector")}
                  />
                  {DESIGN_SYSTEM_CORE_SECTIONS.map((item) => (
                    <SidebarNavItem
                      key={item.id}
                      label={item.label}
                      collapsed={navCollapsed}
                      labelTransition={labelTransition}
                      labelVisible={navLabelVisible}
                      isActive={activeDesignSystemSection === item.id}
                      onClick={() => onDesignSystemSectionChange?.(item.id)}
                    />
                  ))}
                  {!navCollapsed && (
                    <div
                      className={cn(
                        "px-3 pb-1 pt-4 text-sidebar-foreground/25",
                        SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS,
                        navLabelVisible
                          ? "opacity-100"
                          : "opacity-0 overflow-hidden",
                      )}
                    >
                      {t("sections.components")}
                    </div>
                  )}
                  {DESIGN_SYSTEM_COMPONENT_SECTIONS.map((item, index) => (
                    <SidebarNavItem
                      key={item.id}
                      label={item.label}
                      collapsed={navCollapsed}
                      labelTransition={labelTransition}
                      labelVisible={navLabelVisible}
                      isActive={activeDesignSystemSection === item.id}
                      onClick={() => onDesignSystemSectionChange?.(item.id)}
                      labelTransitionDelay={
                        navLabelVisible
                          ? `${(DESIGN_SYSTEM_CORE_SECTIONS.length + index) * 30 + 60}ms`
                          : "0ms"
                      }
                    />
                  ))}
                  {!navCollapsed && (
                    <div
                      className={cn(
                        "px-3 pb-1 pt-4 text-sidebar-foreground/25",
                        SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS,
                        navLabelVisible
                          ? "opacity-100"
                          : "opacity-0 overflow-hidden",
                      )}
                    >
                      {t("sections.notUsed")}
                    </div>
                  )}
                  {DESIGN_SYSTEM_UNUSED_COMPONENT_SECTIONS.map((item) => (
                    <SidebarNavItem
                      key={item.id}
                      label={item.label}
                      collapsed={navCollapsed}
                      labelTransition={labelTransition}
                      labelVisible={navLabelVisible}
                      isActive={activeDesignSystemSection === item.id}
                      onClick={() => onDesignSystemSectionChange?.(item.id)}
                    />
                  ))}
                </>
              )}
            </div>
          </nav>
          <div className={cn("flex-shrink-0", "px-2.5 py-1.5")}>
            <Button
              type="button"
              variant="ghost"
              size={navCollapsed ? "icon-sm" : "default"}
              onClick={isSettingsSurface ? onSettingsBack : onDesignSystemBack}
              className={cn(
                "h-10 w-full rounded-sm bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground active:bg-sidebar-accent",
                SIDEBAR_MENU_HOVER_TRANSITION_CLASS,
                navCollapsed
                  ? "justify-center p-3"
                  : cn("h-auto justify-start", SIDEBAR_NAV_ROW_SPACING_CLASS),
              )}
              title={t("actions.backToMainNavigation")}
              aria-label={t("actions.backToMainNavigation")}
            >
              <IconArrowLeft className="size-4 flex-shrink-0" />
              {!navCollapsed && (
                <span
                  className={cn(
                    "whitespace-nowrap",
                    SIDEBAR_NAV_TEXT_CLASS,
                    labelTransition,
                    navLabelVisible
                      ? "opacity-100 w-auto"
                      : "opacity-0 w-0 overflow-hidden",
                  )}
                >
                  {t("actions.backToMainNavigation")}
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>
      {showPrimaryNavWidthToggle && (
        <div className="flex-shrink-0 px-2.5 py-1.5">
          <SidebarNavItem
            testId="sidebar-primary-nav-width-toggle"
            icon={PrimaryNavWidthToggleIcon}
            label={primaryNavWidthToggleLabel}
            collapsed={navCollapsed}
            labelTransition={labelTransition}
            labelVisible={navLabelVisible}
            isActive={false}
            onClick={onPrimaryNavWidthToggle}
          />
        </div>
      )}
      {renderPrimaryNavResizeRail?.()}
    </PaneSurface>
  );
});
