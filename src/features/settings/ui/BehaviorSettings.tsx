import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { GooseAutoCompactSettings } from "./GooseAutoCompactSettings";
import { useAgentToolsTipsPreference } from "@/features/chat/lib/agentToolsTipPreferences";
import { useSessionCostPreference } from "@/features/chat/lib/sessionCostPreference";
import { useResponseStartGutterPreference } from "@/features/chat/lib/responseStartGutterPreference";
import { useArtifactAutoOpenPreference } from "@/features/chat/lib/artifactAutoOpenPreference";
import {
  useStreamingShortcutPreference,
  type StreamingShortcutMode,
} from "@/features/chat/lib/streamingShortcutPreference";
import { useAtMentionDefaultCategoryPreference } from "@/features/chat/lib/mentionPreference";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { useStyleGuidelinesPreference } from "@/shared/preferences/styleGuidelinesPreference";
import { useMultiWorkspacePreference } from "@/features/workspaces/multiWorkspacePreference";

// Behavior (rev 3): split out of the old GeneralSettings.tsx. Named
// "Behavior" rather than "Chat" because most of what's left here affects
// work in Berd broadly, not just in-chat concerns (file auto-open,
// multi-workspace) -- see settingsSections.ts for the full naming
// rationale. Language lives in System (install-level, not a behavior) and
// Keyboard shortcuts is its own top-level page, so neither is duplicated
// here. Follow-up behavior is the primary.
//
// The global shortcut enable/disable toggle moved to Keyboard Shortcuts
// (KeyboardShortcutsSettings.tsx) -- it's a shortcut-surface setting, not a
// chat/work behavior, and Keyboard shortcuts is where the rest of the
// shortcut configuration (including this shortcut's own chord) already
// lives. Caught by Builderbot review: the toggle had been left behind here
// after Keyboard shortcuts was promoted to its own top-level page.
export function BehaviorSettings() {
  const { t } = useTranslation(["settings", "shortcuts"]);
  const agentToolsTipsPreference = useAgentToolsTipsPreference();
  const sessionCostPreference = useSessionCostPreference();
  const responseStartGutterPreference = useResponseStartGutterPreference();
  const multiWorkspacePreference = useMultiWorkspacePreference();
  const streamingShortcutPreference = useStreamingShortcutPreference();
  const {
    category: atMentionDefaultCategory,
    setCategory: setAtMentionDefaultCategory,
  } = useAtMentionDefaultCategoryPreference();
  const artifactAutoOpenPreference = useArtifactAutoOpenPreference();
  const styleGuidelinesPreference = useStyleGuidelinesPreference();
  const [styleGuidelinesPromptDraft, setStyleGuidelinesPromptDraft] = useState(
    styleGuidelinesPreference.prompt,
  );
  const followUpBehavior =
    streamingShortcutPreference.mode === "cmd-enter-steers" ? "queue" : "steer";
  // "agentTools" is the capability id (main renamed it from the older
  // "agentToolsTip" naming) -- isMac/getPlatform is intentionally dropped
  // here since the global shortcut toggle that needed it moved to
  // KeyboardShortcutsSettings.tsx (see the comment above).
  const showAgentToolsTipsSetting = useProfileCapability("agentTools");

  useEffect(() => {
    setStyleGuidelinesPromptDraft(styleGuidelinesPreference.prompt);
  }, [styleGuidelinesPreference.prompt]);

  function handleStyleGuidelinesPromptSave() {
    const didSave = styleGuidelinesPreference.setPrompt(
      styleGuidelinesPromptDraft,
    );
    if (!didSave) {
      toast.error(t("general.styleGuidelines.saveError"));
    }
  }

  function handleStyleGuidelinesPromptReset() {
    const didSave = styleGuidelinesPreference.resetPrompt();
    if (!didSave) {
      toast.error(t("general.styleGuidelines.saveError"));
    }
  }

  return (
    <SettingsPage title={t("nav.behavior")} contentClassName="space-y-8">
      <SettingsSections>
        <SettingsSection>
          <SettingsRow
            label={t("general.followUpBehavior.label")}
            description={t("general.followUpBehavior.description")}
          >
            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">
                {t("general.followUpBehavior.label")}
              </legend>
              <Button
                type="button"
                aria-pressed={followUpBehavior === "queue"}
                className="min-w-16"
                size="sm"
                variant={followUpBehavior === "queue" ? "primary" : "ghost"}
                onClick={() =>
                  streamingShortcutPreference.setMode(
                    "cmd-enter-steers" satisfies StreamingShortcutMode,
                  )
                }
              >
                {t("general.followUpBehavior.queue")}
              </Button>
              <Button
                type="button"
                aria-pressed={followUpBehavior === "steer"}
                className="min-w-16"
                size="sm"
                variant={followUpBehavior === "steer" ? "primary" : "ghost"}
                onClick={() =>
                  streamingShortcutPreference.setMode(
                    "enter-steers" satisfies StreamingShortcutMode,
                  )
                }
              >
                {t("general.followUpBehavior.steer")}
              </Button>
            </fieldset>
          </SettingsRow>

          <SettingsRow
            label={t("general.atMentionDefault.label")}
            description={t("general.atMentionDefault.description")}
          >
            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">
                {t("general.atMentionDefault.label")}
              </legend>
              <Button
                type="button"
                aria-pressed={atMentionDefaultCategory === "agents"}
                className="min-w-16"
                size="sm"
                variant={
                  atMentionDefaultCategory === "agents" ? "primary" : "ghost"
                }
                onClick={() => setAtMentionDefaultCategory("agents")}
              >
                {t("general.atMentionDefault.agents")}
              </Button>
              <Button
                type="button"
                aria-pressed={atMentionDefaultCategory === "files"}
                className="min-w-16"
                size="sm"
                variant={
                  atMentionDefaultCategory === "files" ? "primary" : "ghost"
                }
                onClick={() => setAtMentionDefaultCategory("files")}
              >
                {t("general.atMentionDefault.files")}
              </Button>
            </fieldset>
          </SettingsRow>

          {showAgentToolsTipsSetting ? (
            <SettingsRow
              label={t("general.agentToolsTips.label")}
              description={t("general.agentToolsTips.description")}
            >
              <Switch
                checked={agentToolsTipsPreference.enabled}
                onCheckedChange={agentToolsTipsPreference.setEnabled}
                aria-label={t("general.agentToolsTips.label")}
              />
            </SettingsRow>
          ) : null}

          <SettingsRow
            label={t("general.sessionCost.label")}
            description={t("general.sessionCost.description")}
          >
            <Switch
              checked={sessionCostPreference.enabled}
              onCheckedChange={sessionCostPreference.setEnabled}
              aria-label={t("general.sessionCost.label")}
            />
          </SettingsRow>

          <SettingsRow
            label={t("general.responseStartGutter.label")}
            description={t("general.responseStartGutter.description")}
          >
            <Switch
              checked={responseStartGutterPreference.enabled}
              onCheckedChange={responseStartGutterPreference.setEnabled}
              aria-label={t("general.responseStartGutter.label")}
            />
          </SettingsRow>

          <SettingsRow
            label={t("general.artifactAutoOpen.label")}
            description={t("general.artifactAutoOpen.description")}
          >
            <Switch
              checked={artifactAutoOpenPreference.enabled}
              onCheckedChange={artifactAutoOpenPreference.setEnabled}
              aria-label={t("general.artifactAutoOpen.label")}
            />
          </SettingsRow>

          <SettingsRow
            label={t("general.multiWorkspace.label")}
            description={t("general.multiWorkspace.description")}
          >
            <Switch
              checked={multiWorkspacePreference.enabled}
              onCheckedChange={multiWorkspacePreference.setEnabled}
              aria-label={t("general.multiWorkspace.label")}
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title={t("general.styleGuidelines.title")}>
          <SettingsRow
            layout="stacked"
            label={
              <label htmlFor="style-guidelines-prompt">
                {t("general.styleGuidelines.promptLabel")}
              </label>
            }
            description={t("general.styleGuidelines.promptDescription")}
            action={
              <div className="space-y-3">
                <Textarea
                  id="style-guidelines-prompt"
                  value={styleGuidelinesPromptDraft}
                  onChange={(event) =>
                    setStyleGuidelinesPromptDraft(event.currentTarget.value)
                  }
                  onBlur={handleStyleGuidelinesPromptSave}
                  placeholder={t("general.styleGuidelines.promptPlaceholder")}
                  className="min-h-52"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={handleStyleGuidelinesPromptReset}
                  >
                    <RotateCcw className="size-3.5" />
                    {t("general.styleGuidelines.reset")}
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="xs"
                    onClick={handleStyleGuidelinesPromptSave}
                    disabled={
                      styleGuidelinesPromptDraft ===
                      styleGuidelinesPreference.prompt
                    }
                  >
                    {t("general.styleGuidelines.save")}
                  </Button>
                </div>
              </div>
            }
          />
        </SettingsSection>

        <SettingsSection title={t("compaction.title")}>
          {/* One row, not two: auto-compact is a control over the Goose
            harness's own compaction, not a separate peer setting, so it
            lives in this row's `details` slot instead of its own SettingsRow
            with a divider before it. No leading icon/badge here (previously
            the Goose provider icon + "Built in" badge) -- that pushed the
            label/description text to the right and threw off alignment with
            the threshold slider below. Layout is "stacked" so the details
            slot renders full-width under the label/description, matching
            the requested layout: label+description, then a Threshold row
            (label + value), then the slider, then the helper text. */}
          <SettingsRow
            layout="stacked"
            label={t("compaction.goose.label")}
            description={t("compaction.goose.description")}
            details={<GooseAutoCompactSettings />}
          />
        </SettingsSection>
      </SettingsSections>
    </SettingsPage>
  );
}
