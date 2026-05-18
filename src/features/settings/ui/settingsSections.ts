import type { ComponentType } from "react";
import { Archive, RefreshCw, Settings2, Stethoscope } from "lucide-react";
import { IconApps, IconPlug } from "@tabler/icons-react";

export const SETTINGS_SECTIONS = [
  { id: "general", labelKey: "nav.general", icon: Settings2 },
  { id: "providers", labelKey: "nav.providers", icon: IconPlug },
  { id: "extensions", labelKey: "nav.extensions", icon: IconApps },
  { id: "archive", labelKey: "nav.archive", icon: Archive },
  { id: "updates", labelKey: "nav.updates", icon: RefreshCw },
  { id: "doctor", labelKey: "nav.doctor", icon: Stethoscope },
] as const satisfies readonly {
  id: string;
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
}[];

export type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SectionId = "general";

const LEGACY_SECTION_REDIRECTS: Record<string, SectionId> = {
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
