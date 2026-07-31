import type { ComponentType } from "react";
import {
  Archive,
  Bell,
  FlaskConical,
  Headphones,
  Keyboard,
  RefreshCw,
  Settings2,
  Shield,
  Stethoscope,
} from "lucide-react";
import { IconPlug, IconServer } from "@tabler/icons-react";
import type {
  ProfileCapabilityId,
  ProfileCapabilityState,
} from "@/shared/profile/capabilities";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";

type SettingsSectionDefinition = {
  id: string;
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
  capability?: ProfileCapabilityId;
};

export const SETTINGS_SECTIONS = [
  { id: "general", labelKey: "nav.general", icon: Settings2 },
  { id: "connections", labelKey: "nav.connections", icon: IconPlug },
  { id: "providers", labelKey: "nav.providers", icon: IconServer },
  { id: "notifications", labelKey: "nav.notifications", icon: Bell },
  { id: "shortcuts", labelKey: "nav.shortcuts", icon: Keyboard },
  {
    id: "voice",
    labelKey: "nav.voice",
    icon: Headphones,
    capability: "voiceConversation",
  },
  { id: "archive", labelKey: "nav.archive", icon: Archive },
  ...(getBuildFeatureState().securityMl
    ? ([{ id: "security", labelKey: "nav.security", icon: Shield }] as const)
    : []),
  {
    id: "updates",
    labelKey: "nav.updates",
    icon: RefreshCw,
    capability: "updates",
  },
  {
    id: "doctor",
    labelKey: "nav.doctor",
    icon: Stethoscope,
    capability: "doctor",
  },
  { id: "experiments", labelKey: "nav.experiments", icon: FlaskConical },
] as const satisfies readonly SettingsSectionDefinition[];

export type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SectionId = "general";

const LEGACY_SECTION_REDIRECTS: Record<string, SectionId> = {
  projects: "archive",
  chats: "archive",
  extensions: "connections",
};

export function isSettingsSection(section: string): section is SectionId {
  return SETTINGS_SECTIONS.some((item) => item.id === section);
}

export function resolveSettingsSection(section: string | null): SectionId {
  if (!section) return DEFAULT_SETTINGS_SECTION;
  if (isSettingsSection(section)) return section;
  return LEGACY_SECTION_REDIRECTS[section] ?? DEFAULT_SETTINGS_SECTION;
}

function getSectionCapability(
  section: (typeof SETTINGS_SECTIONS)[number],
): ProfileCapabilityId | undefined {
  return "capability" in section ? section.capability : undefined;
}

export function isSettingsSectionEnabled(
  section: SectionId,
  capabilities: ProfileCapabilityState,
): boolean {
  const definition = SETTINGS_SECTIONS.find((item) => item.id === section);
  const capability = definition ? getSectionCapability(definition) : undefined;
  return !capability || capabilities[capability];
}

export function resolveEnabledSettingsSection(
  section: SectionId,
  capabilities: ProfileCapabilityState,
): SectionId {
  return isSettingsSectionEnabled(section, capabilities)
    ? section
    : DEFAULT_SETTINGS_SECTION;
}

export function getVisibleSettingsSections(
  capabilities: ProfileCapabilityState,
) {
  return SETTINGS_SECTIONS.filter((section) => {
    const capability = getSectionCapability(section);
    return !capability || capabilities[capability];
  });
}
