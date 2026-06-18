import {
  type LocalePreference,
  LOCALE_STORAGE_KEY,
  SYSTEM_LOCALE,
} from "./constants";
import { i18n } from "./i18n";
import { resolveLocalePreference } from "./locale";

export async function setLocalePreference(
  preference: LocalePreference,
): Promise<void> {
  if (typeof window !== "undefined") {
    try {
      if (preference === SYSTEM_LOCALE) {
        window.localStorage.removeItem(LOCALE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, preference);
      }
    } catch {
      // localStorage may be unavailable
    }
  }

  await i18n.changeLanguage(resolveLocalePreference(preference));
}
