import {
  resolveSettingsSection,
  type SectionId,
} from "@/features/settings/ui/settingsSections";

export function getInitialSettingsSection(): SectionId | null {
  if (typeof window === "undefined") return null;
  if (window.location.pathname !== "/settings") return null;
  const section = new URLSearchParams(window.location.search).get("section");
  return resolveSettingsSection(section);
}

export function setSettingsSectionUrl(section: SectionId) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.pathname = "/settings";
  url.searchParams.set("section", section);
  window.history.replaceState(window.history.state, "", url);
}

export function setDesignSystemUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.pathname = "/design-system";
  url.search = "";
  window.history.replaceState(window.history.state, "", url);
}

export function clearSettingsSectionUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.pathname === "/settings" || url.pathname === "/design-system") {
    url.pathname = "/";
  }
  url.searchParams.delete("section");
  window.history.replaceState(window.history.state, "", url);
}
