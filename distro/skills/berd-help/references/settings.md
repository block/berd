# Settings

Settings is reorganized often — do not name specific section labels, or
claim a setting lives on a specific page, from memory. Verify first:

- `src/features/settings/ui/settingsSections.ts` is the source of truth for
  the current top-level section list, each section's id/label, and legacy id
  redirects (old deep links or stale docs may reference a section id that no
  longer exists — the redirect table is where those land now).
- `src/features/settings/ui/settingsSearchItems.ts` maps individual controls
  to the section that currently owns them. Controls move between sections
  over time, and a control can also move out of Settings entirely into a
  different surface (for example, a display option can end up in the
  sidebar's own menu instead) — check this file rather than recalling a past
  location.
- If source isn't available, use the in-app Settings search or ask the user
  to look, rather than guessing a section name.

Two structural patterns are worth knowing because they're easy to invent a
wrong answer for, and are less likely to change than any section name:

- Settings sections can be gated by capability or hidden from navigation
  (routable by deep link but not shown as a nav item). "I don't see section
  X" is not automatically a bug — it can mean the section isn't enabled for
  this build/install, or it's a hidden sub-surface reached from a row
  elsewhere rather than its own nav entry.
- A settings-adjacent surface can be a dialog opened from a row inside a
  section, rather than its own page. Don't assume every settings destination
  is a navigable page — verify against the file above or the live UI.
