import type { ComponentType } from "react";
import {
  Archive,
  Bell,
  FlaskConical,
  Headphones,
  Keyboard,
  Palette,
  Settings2,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import { IconPlug, IconServer } from "@tabler/icons-react";
import type {
  ProfileCapabilityId,
  ProfileCapabilityState,
} from "@/shared/profile/capabilities";

type SettingsSectionDefinition = {
  id: string;
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
  capability?: ProfileCapabilityId;
  /**
   * Hidden sections are routable (deep links, in-app rows) but do not appear
   * in the settings navigation. Used for full-page sub-surfaces reached from
   * a row inside another section. (Doctor previously used this for its own
   * hidden page reached from System -- rev 4 moved it to a dialog instead,
   * so it's no longer a section at all; see the note below.)
   */
  hidden?: boolean;
};

// Rev 3 (Aug 10): reworked on top of Lauren Kenny's settings UI
// standardization (PR #1004 on main) rather than replacing it -- her shared
// primitives (SettingsPage/SettingsSection/SettingsRow) are unchanged here,
// only the section list and which page owns which rows.
//
// "General" was doing too many unrelated jobs (account, appearance, chat
// behavior, folders, CLI tooling, about) in one 1200-line file. Split into:
//   - "appearance": purely visual (theme, accent color, avatars, indicators)
//   - "behavior": follow-up mode, @ mention default, chat tips, cost
//     estimate, response gutter, artifact auto-open, multi-workspace, style
//     guidelines, compaction -- named "Behavior" (not "Chat") because most
//     of these rows affect work in Berd broadly, not just in-chat concerns
//     (file auto-open, multi-workspace). "Chat" underclaimed the section;
//     "General"/"Workspace"/"Preferences" were considered and rejected as
//     too broad/vague; "Workflow" was rejected because it implies ordered,
//     multi-step processes, which this section doesn't have (yet). Language
//     and Keyboard shortcuts were pulled back out (see below).
//   - "system": install-level (language, artifact/terminal folders, cached
//     media, bb CLI, dev runtime config) + a row that opens Doctor as its
//     own page. Language lives here, not "behavior": it's an install-level,
//     "which language does Berd speak" setting, not a per-chat behavior.
//
// Rev 5 (Aug 19): "about" is no longer its own section -- app identity +
// "is it current" (Updates card) + Account are still one concept, but they
// now live at the bottom of "system" under an "About" subhead instead of a
// separate nav destination. "Check for updates" moved to the top of System
// since it's the row people actually look for; the rest of About's
// identity rows (build mode, Tauri version, identifier, license) and
// Account stayed together underneath. `about` and the legacy `updates`
// route both redirect to `system` now.
//
// "Agents" was considered for "providers" but collides with the primary
// nav's real "Agents" destination (PrimaryNavigationSurface.tsx) -- kept as
// "AI providers" (nav.providers), unchanged from main.
//
// "Chats & projects" was considered for "behavior" but the archive-list
// version of that idea doesn't match how Archive actually exists in this
// codebase (ArchiveSettings.tsx is one plain page, not a card-with-
// sub-pages) -- Archive stays a separate top-level section, unchanged from
// main. Keyboard shortcuts is also its own top-level section (see below),
// so there's no link to it from "behavior" either.
//
// Security is now permanent (previously gated behind the whole-section
// `securityMl` build flag). Trusted link domains -- previously buried in
// General/Storage -- moved in as real, always-available content, so the
// section isn't empty for people without the ML build flag. ML rows stay
// gated *inside* the page, not at the nav level.
//
// Doctor is not a settings section at all (rev 4): it opens as a dialog from
// a row inside System instead of navigating anywhere. It was previously a
// hidden sub-page reached from a System row, but feedback was that being the
// only settings surface with a deeper nav level felt off -- and once its
// action buttons (Rerun/Copy details) moved out of the app's top-bar slot
// into a settings-surface actions area, its content stopped needing a full
// page to hold them. `doctor` is kept in LEGACY_SECTION_REDIRECTS below so
// old deep links (`/settings?section=doctor`) land on System, where the row
// that opens the dialog now lives.
//
// Experiments stays a real top-level section, unchanged from main.
export const SETTINGS_SECTIONS = [
  { id: "appearance", labelKey: "nav.appearance", icon: Palette },
  { id: "behavior", labelKey: "nav.behavior", icon: SlidersHorizontal },
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
  { id: "security", labelKey: "nav.security", icon: Shield },
  { id: "system", labelKey: "nav.system", icon: Settings2 },
  { id: "experiments", labelKey: "nav.experiments", icon: FlaskConical },
] as const satisfies readonly SettingsSectionDefinition[];

export type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const DEFAULT_SETTINGS_SECTION: SectionId = "appearance";

const LEGACY_SECTION_REDIRECTS: Record<string, SectionId> = {
  general: "appearance",
  projects: "archive",
  chats: "archive",
  extensions: "connections",
  // rev 5: "about" is no longer a section -- app identity, the update
  // check, and Account now live at the bottom of "system" under an "About"
  // subhead. Both the legacy `about` route and the older `updates` route
  // (which redirected to `about` in rev 3) land on `system`.
  about: "system",
  updates: "system",
  // rev 4: "doctor" was a hidden sub-page reached from System; it's now a
  // dialog opened from a row on that same page, not a section at all. Old
  // deep links land on System, where the row lives.
  doctor: "system",
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

function isSectionHidden(section: (typeof SETTINGS_SECTIONS)[number]): boolean {
  return "hidden" in section && section.hidden === true;
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
    if (isSectionHidden(section)) {
      return false;
    }
    const capability = getSectionCapability(section);
    return !capability || capabilities[capability];
  });
}
