import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  ExperimentConfigControl,
  ExperimentDefinition,
} from "./experimentDefinitions";
import {
  setExperimentConfigValue,
  type ExperimentRegistry,
  type ExperimentState,
} from "./experimentPreferences";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { SettingsRow } from "@/shared/ui/settings-row";

interface ExperimentConfigControlsProps {
  definition: ExperimentDefinition;
  experiment: ExperimentState;
  registry?: ExperimentRegistry;
  disabled?: boolean;
}

export function ExperimentConfigControls({
  definition,
  experiment,
  registry,
  disabled = false,
}: ExperimentConfigControlsProps) {
  const { t } = useTranslation("settings");
  const controls = Object.entries(definition.config ?? {});

  if (controls.length === 0) return null;

  function handleConfigChange(key: string, value: boolean | number | string) {
    const didSave = setExperimentConfigValue(
      definition.id,
      key,
      value,
      registry,
    );
    if (!didSave) {
      toast.error(t("experiments.saveError"));
    }
    return didSave;
  }

  return (
    <div className="bg-muted/20">
      {controls.map(([key, control]) => {
        const controlId = `experiment-${definition.id}-${key}`;
        const description = control.descriptionKey
          ? t(control.descriptionKey)
          : null;
        const isMultilineTextControl =
          control.type === "text" && control.multiline !== false;
        const isStackedControl = isMultilineTextControl;
        const controlContainerClassName = isStackedControl
          ? "w-full"
          : control.type === "boolean"
            ? "flex shrink-0 justify-end"
            : "w-40 flex-shrink-0";

        return (
          <SettingsRow
            key={key}
            density="compact"
            layout={isStackedControl ? "stacked" : "inline"}
            className="relative before:absolute before:top-0 before:right-4 before:left-0 before:border-t before:content-['']"
            label={
              <Label
                htmlFor={controlId}
                className="text-xs text-muted-foreground"
              >
                {t(control.labelKey)}
              </Label>
            }
            description={description}
            descriptionClassName="mt-1"
            actionClassName={controlContainerClassName}
            action={
              <>
                {control.type === "boolean" ? (
                  <Switch
                    id={controlId}
                    disabled={disabled}
                    checked={Boolean(experiment.config[key])}
                    onCheckedChange={(checked) =>
                      handleConfigChange(key, checked)
                    }
                    aria-label={t(control.labelKey)}
                  />
                ) : null}
                {control.type === "select" ? (
                  <Select
                    disabled={disabled}
                    value={String(experiment.config[key])}
                    onValueChange={(value) => handleConfigChange(key, value)}
                  >
                    <SelectTrigger id={controlId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {control.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {control.type === "number" ? (
                  <NumberExperimentControl
                    id={controlId}
                    control={control}
                    disabled={disabled}
                    value={Number(experiment.config[key])}
                    onCommit={(value) => handleConfigChange(key, value)}
                  />
                ) : null}
                {control.type === "text" ? (
                  <TextExperimentControl
                    id={controlId}
                    disabled={disabled}
                    multiline={control.multiline !== false}
                    value={String(experiment.config[key])}
                    placeholder={control.placeholderKey}
                    onCommit={(value) => handleConfigChange(key, value)}
                  />
                ) : null}
              </>
            }
          />
        );
      })}
    </div>
  );
}

function TextExperimentControl({
  id,
  disabled,
  multiline,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  disabled: boolean;
  multiline: boolean;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => boolean;
}) {
  const { t } = useTranslation("settings");
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const commitDraft = useCallback(
    (nextValue = draftValue) => {
      if (nextValue === value) return true;

      const didSave = onCommit(nextValue);
      if (!didSave) {
        setDraftValue(value);
      }
      return didSave;
    },
    [draftValue, onCommit, value],
  );

  useEffect(() => {
    if (disabled || draftValue === value) return;

    const timeoutId = window.setTimeout(() => {
      commitDraft(draftValue);
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [commitDraft, disabled, draftValue, value]);

  const inputProps = {
    id,
    disabled,
    value: draftValue,
    placeholder: placeholder ? t(placeholder) : undefined,
    onBlur: () => commitDraft(),
    onChange: (
      event: ChangeEvent<HTMLInputElement> | ChangeEvent<HTMLTextAreaElement>,
    ) => setDraftValue(event.currentTarget.value),
  };

  if (!multiline) {
    return <Input {...inputProps} />;
  }

  return (
    <Textarea {...inputProps} className="min-h-32 resize-y" variant="code" />
  );
}

function NumberExperimentControl({
  id,
  control,
  disabled,
  value,
  onCommit,
}: {
  id: string;
  control: Extract<ExperimentConfigControl, { type: "number" }>;
  disabled: boolean;
  value: number;
  onCommit: (value: number) => boolean;
}) {
  const [draftValue, setDraftValue] = useState(String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  function commitDraft() {
    if (draftValue.trim() === "") {
      setDraftValue(String(value));
      return;
    }

    const nextValue = Number(draftValue);
    if (!Number.isFinite(nextValue)) {
      setDraftValue(String(value));
      return;
    }

    const didSave = onCommit(nextValue);
    if (!didSave) {
      setDraftValue(String(value));
    }
  }

  return (
    <Input
      id={id}
      type="number"
      disabled={disabled}
      value={draftValue}
      min={control.min}
      max={control.max}
      step={control.step}
      onBlur={commitDraft}
      onChange={(event) => setDraftValue(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
