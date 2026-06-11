import type { ComponentType } from "react";
import {
  Archive,
  Bell,
  FlaskConical,
  Keyboard,
  Link2,
  RefreshCw,
  Settings2,
  Stethoscope,
} from "lucide-react";
import { IconPlug } from "@tabler/icons-react";

export const SETTINGS_SECTIONS = [
  { id: "general", labelKey: "nav.general", icon: Settings2 },
  { id: "providers", labelKey: "nav.providers", icon: IconPlug },
  { id: "connections", labelKey: "nav.connections", icon: Link2 },
  { id: "notifications", labelKey: "nav.notifications", icon: Bell },
  { id: "shortcuts", labelKey: "nav.shortcuts", icon: Keyboard },
  { id: "archive", labelKey: "nav.archive", icon: Archive },
  { id: "updates", labelKey: "nav.updates", icon: RefreshCw },
  { id: "doctor", labelKey: "nav.doctor", icon: Stethoscope },
  { id: "experiments", labelKey: "nav.experiments", icon: FlaskConical },
] as const satisfies readonly {
  id: string;
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
}[];

export type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SectionId = "general";

const LEGACY_SECTION_REDIRECTS: Record<string, SectionId> = {
  extensions: "connections",
  projects: "archive",
  chats: "archive",
  voice: "general",
};

export function isSettingsSection(section: string): section is SectionId {
  return SETTINGS_SECTIONS.some((item) => item.id === section);
}

export function resolveSettingsSection(section: string | null): SectionId {
  if (!section) return DEFAULT_SETTINGS_SECTION;
  if (isSettingsSection(section)) return section;
  return LEGACY_SECTION_REDIRECTS[section] ?? DEFAULT_SETTINGS_SECTION;
}
