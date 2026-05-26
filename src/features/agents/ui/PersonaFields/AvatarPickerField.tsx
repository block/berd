import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { AvatarLibraryPicker } from "@/features/agents/ui/AvatarLibraryPicker";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";

export interface AvatarPickerFieldClasses {
  sectionGap?: string;
  fieldLabel?: string;
  fieldInput?: string;
  validationError?: string;
  previewError?: string;
}

export interface AvatarPickerFieldProps {
  urlValue: string;
  onUrlChange: (next: string) => void;
  urlError: string | null;
  validationError: string | null;
  library: AvatarLibraryState;
  selectedAvatarRef: string | null;
  onSelectAvatar: (avatarId: string) => void;
  onPreviewError: () => void;
  previewFailed: boolean;
  isReadOnly?: boolean;
  /** When true, the custom URL field is hidden. */
  hideUrl?: boolean;
  classes?: AvatarPickerFieldClasses;
  /** When true, the library picker section is hidden (e.g. read-only surfaces). */
  hideLibrary?: boolean;
  urlInputId?: string;
}

export function AvatarPickerField({
  urlValue,
  onUrlChange,
  urlError,
  validationError,
  library,
  selectedAvatarRef,
  onSelectAvatar,
  onPreviewError,
  previewFailed,
  isReadOnly = false,
  hideUrl = false,
  classes,
  hideLibrary = false,
  urlInputId = "persona-avatar-url",
}: AvatarPickerFieldProps) {
  const { t } = useTranslation(["agents", "common"]);
  const displayedError = validationError ?? urlError;
  const errorId = `${urlInputId}-error`;

  return (
    <>
      {!hideUrl ? (
        <div className={classes?.sectionGap}>
          <Label htmlFor={urlInputId} className={classes?.fieldLabel}>
            {t("editor.avatarUrl")}
          </Label>
          <Input
            id={urlInputId}
            type="text"
            inputMode="url"
            value={urlValue}
            onChange={(event) => onUrlChange(event.target.value)}
            readOnly={isReadOnly}
            placeholder={t("editor.avatarUrlPlaceholder")}
            aria-invalid={displayedError ? true : undefined}
            aria-describedby={displayedError ? errorId : undefined}
            className={cn(
              classes?.fieldInput,
              isReadOnly && "cursor-not-allowed opacity-70",
            )}
          />
          {displayedError ? (
            <p
              id={errorId}
              className={cn(
                "text-[11px] text-destructive",
                classes?.validationError,
              )}
            >
              {displayedError}
            </p>
          ) : null}
        </div>
      ) : null}

      {!hideLibrary && !isReadOnly ? (
        <div className="space-y-2">
          <Label className={classes?.fieldLabel}>
            {t("editor.avatarLibrary")}
          </Label>
          <AvatarLibraryPicker
            library={library}
            selectedAvatarRef={selectedAvatarRef}
            onSelectAvatar={onSelectAvatar}
            onPreviewError={onPreviewError}
          />
          {previewFailed ? (
            <p
              className={cn(
                "text-[11px] text-muted-foreground",
                classes?.previewError,
              )}
            >
              {t("avatar.loadFailed")}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
