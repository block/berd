import type { ChangeEventHandler } from "react";
import { Check, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AvatarLibraryPicker } from "@/features/agents/ui/AvatarLibraryPicker";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";

interface AgentAvatarSectionProps {
  avatarPreviewFailed: boolean;
  avatarPickerDisabled?: boolean;
  avatarUrlError: string | null;
  avatarUrlInputId: string;
  canSaveCustomAvatar?: boolean;
  clearDisabled?: boolean;
  customAvatarUrlValue: string;
  fieldGroupClassName: string;
  fieldInputClassName: string;
  fieldLabelClassName: string;
  library: AvatarLibraryState;
  onAvatarUrlChange: ChangeEventHandler<HTMLInputElement>;
  onClearAvatar: () => void;
  onPreviewError: () => void;
  onSaveCustomAvatar?: () => void;
  onSelectAvatar: (avatarId: string) => void;
  selectedAvatarRef: string | null;
  showClearAvatar: boolean;
  title: string;
}

export function AgentAvatarSection({
  avatarPreviewFailed,
  avatarPickerDisabled = false,
  avatarUrlError,
  avatarUrlInputId,
  canSaveCustomAvatar = false,
  clearDisabled = false,
  customAvatarUrlValue,
  fieldGroupClassName,
  fieldInputClassName,
  fieldLabelClassName,
  library,
  onAvatarUrlChange,
  onClearAvatar,
  onPreviewError,
  onSaveCustomAvatar,
  onSelectAvatar,
  selectedAvatarRef,
  showClearAvatar,
  title,
}: AgentAvatarSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const titleId = `${avatarUrlInputId}-section-title`;
  const errorId = `${avatarUrlInputId}-error`;

  return (
    <section
      aria-labelledby={titleId}
      className="agents-unpaired-enter space-y-5 border-y border-surface-agent-profile-border py-6"
      style={{ animationDelay: "40ms" }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <h2
          id={titleId}
          className="truncate text-[20px] font-normal leading-6 text-surface-agent-profile-fg"
        >
          {title}
        </h2>
      </div>

      <div className={fieldGroupClassName}>
        <Label htmlFor={avatarUrlInputId} className={fieldLabelClassName}>
          {t("editor.avatarUrl")}
        </Label>
        <div className="flex gap-2">
          <Input
            id={avatarUrlInputId}
            type="text"
            inputMode="url"
            value={customAvatarUrlValue}
            onChange={onAvatarUrlChange}
            placeholder={t("editor.avatarUrlPlaceholder")}
            aria-invalid={avatarUrlError ? true : undefined}
            aria-describedby={avatarUrlError ? errorId : undefined}
            className={fieldInputClassName}
          />
          {onSaveCustomAvatar ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("common:actions.save")}
              title={t("common:actions.save")}
              className="shrink-0 rounded-full"
              disabled={!canSaveCustomAvatar}
              onClick={onSaveCustomAvatar}
            >
              <Check className="size-3.5" />
            </Button>
          ) : null}
          {showClearAvatar ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("avatar.removeAria")}
              className="shrink-0 rounded-full"
              disabled={clearDisabled}
              onClick={onClearAvatar}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </div>
        {avatarUrlError ? (
          <p id={errorId} className="text-[11px] text-destructive">
            {avatarUrlError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label className={fieldLabelClassName}>
          {t("editor.avatarBundled")}
        </Label>
        <AvatarLibraryPicker
          library={library}
          selectedAvatarRef={selectedAvatarRef}
          onSelectAvatar={onSelectAvatar}
          onPreviewError={onPreviewError}
          disabled={avatarPickerDisabled}
        />
        {avatarPreviewFailed ? (
          <p className="text-[11px] text-muted-foreground">
            {t("avatar.loadFailed")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
