import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";

export function RemoteSessionUnavailableNotice() {
  const { t } = useTranslation("chat");
  return (
    <Alert role="status" className="mb-2">
      <AlertTitle>{t("remoteSessionUnavailable.title")}</AlertTitle>
      <AlertDescription>
        {t("remoteSessionUnavailable.description")}
      </AlertDescription>
    </Alert>
  );
}
