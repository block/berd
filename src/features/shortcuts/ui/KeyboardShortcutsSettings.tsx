import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  resetAllShortcutOverrides,
  resetShortcutOverride,
  resolveShortcutCommands,
  setShortcutOverride,
  SHORTCUT_CATEGORIES,
  useShortcutPreferences,
  type ResolvedShortcutCommand,
  type ShortcutCommandId,
} from "@/features/shortcuts/lib/shortcutRegistry";
import { useGlobalShortcutPreference } from "@/features/global-shortcut/globalShortcutPreference";
import {
  keyboardShortcutDisplayParts,
  keyboardShortcutFromEvent,
} from "@/shared/keyboard/keyboardShortcut";
import { cn } from "@/shared/lib/cn";
import { getPlatform } from "@/shared/lib/platform";
import { Button } from "@/shared/ui/button";
import { Kbd } from "@/shared/ui/kbd";
import { SearchBar } from "@/shared/ui/SearchBar";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import { Switch } from "@/shared/ui/switch";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";

type RowError =
  | { commandId: ShortcutCommandId; kind: "invalid" }
  | {
      commandId: ShortcutCommandId;
      kind: "conflict";
      conflictDescriptionKey: string;
    };

function editButtonId(commandId: ShortcutCommandId): string {
  return `shortcut-edit-${commandId}`;
}

function rowHintId(commandId: ShortcutCommandId): string {
  return `shortcut-hint-${commandId}`;
}

function rowErrorId(commandId: ShortcutCommandId): string {
  return `shortcut-error-${commandId}`;
}

export function KeyboardShortcutsSettings() {
  const { t } = useTranslation("shortcuts");
  const isMac = getPlatform() === "mac";
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<ShortcutCommandId | null>(
    null,
  );
  const [rowError, setRowError] = useState<RowError | null>(null);
  const globalShortcutPreference = useGlobalShortcutPreference();

  const preferences = useShortcutPreferences();

  const commands = resolveShortcutCommands().filter(
    (command) => command.configurable,
  );
  const hasOverrides = Object.keys(preferences.overrides).length > 0;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleCommands = commands.filter((command) =>
    t(command.descriptionKey).toLowerCase().includes(normalizedQuery),
  );
  const groups = SHORTCUT_CATEGORIES.map((category) => ({
    category,
    commands: visibleCommands.filter(
      (command) => command.category === category,
    ),
  })).filter((group) => group.commands.length > 0);

  function startRecording(commandId: ShortcutCommandId) {
    setRecordingId(commandId);
    setRowError(null);
  }

  // Id-aware so a blur fired by handing recording to another row (WebKit
  // focuses buttons on click, after the new row already started) only
  // cancels its own row.
  function stopRecording(commandId: ShortcutCommandId) {
    setRecordingId((current) => (current === commandId ? null : current));
  }

  function handleRecordingKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    command: ResolvedShortcutCommand,
  ) {
    // Never let captured presses reach global shortcut handlers.
    event.preventDefault();
    event.stopPropagation();

    // A held key (e.g. the Enter that activated the button) must not
    // record on auto-repeat, and IME composition keydowns (key "Process")
    // are not chords.
    if (event.repeat || event.nativeEvent.isComposing) {
      return;
    }

    if (event.key === "Escape") {
      stopRecording(command.id);
      setRowError(null);
      return;
    }

    // Capture permissively; pure-modifier presses return null (keep
    // recording). setShortcutOverride re-validates against the command's
    // own allowUnmodified rule so e.g. a bare "k" on a global command
    // surfaces the inline "invalid" error instead of being ignored.
    const captured = keyboardShortcutFromEvent(event.nativeEvent, {
      allowUnmodified: true,
    });
    if (!captured) {
      return;
    }

    const result = setShortcutOverride(command.id, captured);
    if (result.ok) {
      stopRecording(command.id);
      setRowError(null);
      return;
    }
    if (result.reason === "invalid") {
      setRowError({ commandId: command.id, kind: "invalid" });
      return;
    }
    if (result.reason === "conflict") {
      stopRecording(command.id);
      setRowError({
        commandId: command.id,
        kind: "conflict",
        conflictDescriptionKey: result.conflict.descriptionKey,
      });
      return;
    }
    stopRecording(command.id);
    setRowError(null);
    toast.error(t("settings.saveError"));
  }

  function handleReset(commandId: ShortcutCommandId) {
    resetShortcutOverride(commandId);
    setRowError((current) =>
      current?.commandId === commandId ? null : current,
    );
    // The per-row reset button unmounts itself; keep keyboard focus in
    // the row instead of dropping it to the body.
    document.getElementById(editButtonId(commandId))?.focus();
  }

  function handleResetAll() {
    resetAllShortcutOverrides();
    setRecordingId(null);
    setRowError(null);
    // "Reset all" disables itself afterwards; move focus to the search
    // input so keyboard users are not stranded.
    searchInputRef.current?.focus();
  }

  function renderRow(command: ResolvedShortcutCommand) {
    const label = t(command.descriptionKey);
    const isRecording = recordingId === command.id;
    const error = rowError?.commandId === command.id ? rowError : null;
    const binding = command.bindings[0];
    const defaultBinding = command.defaultBindings[0];
    const isOverridden = command.override !== null;
    // aria-label replaces the button's content for screen readers, so the
    // current combo has to ride along in the label itself.
    const comboLabel = binding
      ? keyboardShortcutDisplayParts(binding.shortcut, isMac).join(
          isMac ? "" : "+",
        )
      : null;
    const editLabel = t("settings.editLabel", { command: label });

    return (
      <SettingsRow
        key={command.id}
        density="compact"
        label={label}
        description={
          isOverridden && defaultBinding
            ? t("settings.default", {
                shortcut: keyboardShortcutDisplayParts(
                  defaultBinding.shortcut,
                  isMac,
                ).join(isMac ? "" : "+"),
              })
            : undefined
        }
        action={
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {isOverridden ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                tooltip={t("settings.reset")}
                aria-label={t("settings.reset")}
                onClick={() => handleReset(command.id)}
              >
                <RotateCcw />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              id={editButtonId(command.id)}
              className={cn(
                "w-fit px-1.5",
                isRecording && "ring-2 ring-ring ring-offset-1",
              )}
              aria-label={
                comboLabel ? `${editLabel} (${comboLabel})` : editLabel
              }
              aria-describedby={
                [
                  isRecording ? rowHintId(command.id) : null,
                  error ? rowErrorId(command.id) : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              data-shortcut-recording={isRecording ? "true" : undefined}
              onClick={(event) => {
                if (isRecording) return;
                startRecording(command.id);
                event.currentTarget.focus();
              }}
              onKeyDown={(event) => {
                if (!isRecording) return;
                handleRecordingKeyDown(event, command);
              }}
              onBlur={() => {
                if (isRecording) stopRecording(command.id);
              }}
            >
              {isRecording ? (
                <span className="text-muted-foreground">
                  {t("settings.recording")}
                </span>
              ) : binding ? (
                <span className="flex items-center gap-1">
                  {keyboardShortcutDisplayParts(binding.shortcut, isMac).map(
                    (part) => (
                      <Kbd key={part} className="shadow-none">
                        {part}
                      </Kbd>
                    ),
                  )}
                </span>
              ) : null}
            </Button>
          </div>
        }
        details={
          isRecording || error ? (
            <>
              {isRecording ? (
                <p
                  id={rowHintId(command.id)}
                  role="status"
                  className="text-xs text-muted-foreground"
                >
                  {t("settings.recordingHint")}
                </p>
              ) : null}
              {error ? (
                <p
                  id={rowErrorId(command.id)}
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {error.kind === "invalid"
                    ? t(
                        command.allowUnmodified
                          ? "settings.invalidUnmodified"
                          : "settings.invalid",
                      )
                    : t("settings.conflict", {
                        command: t(error.conflictDescriptionKey),
                      })}
                </p>
              ) : null}
            </>
          ) : undefined
        }
      />
    );
  }

  return (
    <SettingsPage
      title={t("settings.title")}
      description={t("settings.pageDescription")}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleResetAll}
          disabled={!hasOverrides}
        >
          {t("settings.resetAll")}
        </Button>
      }
      contentClassName="space-y-8"
    >
      {isMac ? (
        <SettingsSections>
          <SettingsSection>
            <SettingsRow
              label={t("settings.globalShortcut.label")}
              description={t("settings.globalShortcut.description")}
            >
              <Switch
                checked={globalShortcutPreference.enabled}
                onCheckedChange={globalShortcutPreference.setEnabled}
                aria-label={t("settings.globalShortcut.label")}
              />
            </SettingsRow>
          </SettingsSection>
        </SettingsSections>
      ) : null}
      <SearchBar
        size="pill"
        inputRef={searchInputRef}
        value={query}
        onChange={setQuery}
        placeholder={t("settings.searchPlaceholder")}
        aria-label={t("settings.searchPlaceholder")}
      />
      {groups.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          {t("settings.empty")}
        </p>
      ) : (
        <SettingsSections>
          {groups.map((group) => (
            <SettingsSection
              key={group.category}
              title={t(`categories.${group.category}`)}
            >
              {group.commands.map(renderRow)}
            </SettingsSection>
          ))}
        </SettingsSections>
      )}
    </SettingsPage>
  );
}
