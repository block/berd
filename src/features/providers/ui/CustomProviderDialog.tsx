import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconTrash,
} from "@tabler/icons-react";
import {
  CustomProviderForm,
  type CustomProviderFormValues,
  type ProviderTemplate,
} from "./CustomProviderForm";
import { ProviderTemplatePicker } from "./ProviderTemplatePicker";

export type CustomProviderMutationInput = Omit<
  CustomProviderFormValues,
  "providerId"
> & {
  providerId?: string;
};

interface CustomProviderDialogProps {
  open: boolean;
  mode: "create" | "edit";
  provider?: CustomProviderFormValues | null;
  templates?: ProviderTemplate[];
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CustomProviderMutationInput) => Promise<void>;
  onUpdate: (
    providerId: string,
    input: CustomProviderMutationInput,
  ) => Promise<void>;
  onDelete?: (providerId: string) => Promise<boolean | undefined>;
}

const EMPTY_FORM: CustomProviderFormValues = {
  displayName: "",
  engine: "openai_compatible",
  apiUrl: "",
  basePath: "",
  requiresAuth: true,
  apiKey: "",
  apiKeySet: false,
  models: [],
  authInitiallyEnabled: true,
  supportsStreaming: true,
  headers: [],
};

// Create opens straight onto the template list ("template"); "Fully custom"
// is a secondary action inside that step, not an upfront fork.
type CreateStep = "template" | "form";

const CUSTOM_PROVIDER_FORM_ID = "custom-provider-form";

function valueFromTemplate(
  template: ProviderTemplate,
): CustomProviderFormValues {
  return {
    ...EMPTY_FORM,
    displayName: template.displayName,
    engine: template.engine,
    apiUrl: template.apiUrl,
    basePath: template.basePath ?? "",
    requiresAuth: template.requiresAuth,
    authInitiallyEnabled: template.requiresAuth,
    models: template.models,
    supportsStreaming: template.supportsStreaming,
    headers: template.headers,
    catalogProviderId: template.id,
  };
}

export function CustomProviderDialog({
  open,
  mode,
  provider,
  templates = [],
  onOpenChange,
  onCreate,
  onUpdate,
  onDelete,
}: CustomProviderDialogProps) {
  const { t } = useTranslation("settings");
  const [value, setValue] = useState<CustomProviderFormValues>(EMPTY_FORM);
  const [createStep, setCreateStep] = useState<CreateStep>("template");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [formValid, setFormValid] = useState(false);
  const openStateKeyRef = useRef<string | null>(null);
  const templateById = useMemo(
    () => new Map(templates.map((template) => [template.id, template])),
    [templates],
  );

  useEffect(() => {
    if (!open) {
      openStateKeyRef.current = null;
      return;
    }
    const openStateKey = `${mode}:${provider?.providerId ?? "new"}`;
    if (openStateKeyRef.current === openStateKey) {
      return;
    }
    openStateKeyRef.current = openStateKey;
    setValue(provider ?? EMPTY_FORM);
    setCreateStep(mode === "create" ? "template" : "form");
    setSaving(false);
    setDeleting(false);
    setError("");
  }, [mode, open, provider]);

  function handleStartManual() {
    setValue(EMPTY_FORM);
    setCreateStep("form");
  }

  function handleSelectTemplate(templateId: string) {
    const template = templateById.get(templateId);
    setValue(template ? valueFromTemplate(template) : EMPTY_FORM);
    setCreateStep("form");
  }

  function handleBack() {
    setError("");
    setCreateStep("template");
  }

  async function handleSubmit() {
    setSaving(true);
    setError("");
    try {
      if (mode === "edit" && value.providerId) {
        await onUpdate(value.providerId, value);
      } else {
        await onCreate(value);
      }
      onOpenChange(false);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t("providers.custom.errors.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!value.providerId || !onDelete) {
      return;
    }

    setDeleting(true);
    setError("");
    try {
      const deleted = await onDelete(value.providerId);
      if (deleted === false) {
        return;
      }
      onOpenChange(false);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t("providers.custom.errors.deleteFailed"),
      );
    } finally {
      setDeleting(false);
    }
  }

  function renderBody() {
    if (mode === "create" && createStep === "template") {
      // The picker owns its internal scroll (list scrolls; search and the
      // fully-custom action stay pinned), so it fills the body zone.
      return (
        <DialogBody className="flex flex-col space-y-0 overflow-hidden">
          <ProviderTemplatePicker
            templates={templates}
            onSelect={handleSelectTemplate}
            onStartManual={handleStartManual}
            disabled={saving || deleting}
          />
        </DialogBody>
      );
    }

    return (
      <DialogBody>
        <CustomProviderForm
          id={CUSTOM_PROVIDER_FORM_ID}
          value={value}
          mode={mode}
          saving={saving}
          deleting={deleting}
          error={error}
          onChange={setValue}
          onSubmit={() => void handleSubmit()}
          onValidityChange={setFormValid}
        />
      </DialogBody>
    );
  }

  // All actions live in the footer: back on the left, destructive +
  // confirming on the right. The submit button targets the body form by id.
  function renderFooter() {
    if (mode === "create" && createStep === "template") {
      return null;
    }

    return (
      <DialogFooter>
        {mode === "create" ? (
          <Button
            type="button"
            variant="ghost"
            onClick={handleBack}
            disabled={saving || deleting}
            leftIcon={<IconArrowLeft />}
            flush
            className="sm:mr-auto"
          >
            {t("providers.custom.actions.back")}
          </Button>
        ) : null}
        {mode === "edit" && onDelete ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => void handleDelete()}
            disabled={saving || deleting}
            leftIcon={<IconTrash />}
            destructive
            className="sm:mr-auto"
          >
            {deleting
              ? t("providers.custom.actions.deleting")
              : t("providers.custom.actions.delete")}
          </Button>
        ) : null}
        <Button
          type="submit"
          form={CUSTOM_PROVIDER_FORM_ID}
          disabled={saving || deleting || !formValid}
          leftIcon={<IconDeviceFloppy />}
        >
          {saving
            ? t("providers.custom.actions.saving")
            : mode === "edit"
              ? t("providers.custom.actions.save")
              : t("providers.custom.actions.create")}
        </Button>
      </DialogFooter>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="h-[min(680px,calc(100vh-2rem))]">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit"
              ? t("providers.custom.editTitle")
              : t("providers.custom.addTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("providers.custom.description")}
          </DialogDescription>
        </DialogHeader>

        {renderBody()}
        {renderFooter()}
      </DialogContent>
    </Dialog>
  );
}
