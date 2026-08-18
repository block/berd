import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import { Link2 } from "lucide-react";
import {
  CONNECTIONS_QUERY_KEY,
  disconnectConnection,
} from "@/features/connections/api/connections";
import type { OAuthProviderEntry } from "@/features/connections/catalog";
import type { ConnectionStatus } from "@/features/connections/lib/connectionStatus";
import { isAlwaysOnAllowed } from "@/features/extensions/lib/keepEnabled";
import {
  getDisplayName,
  type ExtensionEntry,
} from "@/features/extensions/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ConnectionCard } from "./ConnectionCard";

const DEFAULT_G2_BASE_URL = "https://g2.sqprod.co";
const G2_BASE_URL =
  import.meta.env.VITE_BERD_G2_BASE_URL ??
  import.meta.env.VITE_GOOSE_INTERNAL_G2_BASE_URL ??
  DEFAULT_G2_BASE_URL;
const RETURN_URL = "berd://connect-return";

function buildConnectUrl(extensionName: string): string {
  const params = new URLSearchParams({
    extension: extensionName,
    return: RETURN_URL,
  });
  return `${G2_BASE_URL}/connections/start?${params.toString()}`;
}

export function OAuthStatusBadge({ status }: { status: ConnectionStatus }) {
  const { t } = useTranslation("settings");

  if (status.kind !== "expired" && status.kind !== "expiring") return null;

  const label =
    status.kind === "expired"
      ? t("connections.status.expired")
      : status.daysUntilExpiry === 0
        ? t("connections.expiresToday")
        : status.daysUntilExpiry === 1
          ? t("connections.expiresTomorrow")
          : t("connections.expiresInDays", {
              count: status.daysUntilExpiry,
            });
  // Inline status text next to the name, matching the name's type styling
  // exactly — only the color differs: red for expired, orange for expiring.
  return (
    <span
      className={cn(
        "text-sm",
        status.kind === "expired" ? "text-destructive" : "text-warning",
      )}
    >
      {label}
    </span>
  );
}

function useOAuthConnect() {
  const { t } = useTranslation("settings");
  return async (provider: string) => {
    try {
      await invoke("open_in_chrome", { url: buildConnectUrl(provider) });
    } catch (error) {
      console.warn("Failed to launch connect flow:", error);
      toast.error(t("connections.connectError"));
    }
  };
}

function useOAuthDisconnect() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  return async (provider: string) => {
    try {
      await disconnectConnection(provider);
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
    } catch (error) {
      console.warn("Failed to disconnect:", error);
      toast.error(t("connections.disconnectError"));
    }
  };
}

function oauthButtonLabelKey(status: ConnectionStatus): string | null {
  switch (status.kind) {
    case "disconnected":
      return "connections.connect";
    case "expiring":
      return "connections.extendAccess";
    case "expired":
      return "connections.reconnect";
    default:
      return null;
  }
}

export function OAuthConnectionActions({
  entry,
  status,
  size = "sm",
}: {
  entry: OAuthProviderEntry;
  status: ConnectionStatus;
  size?: "sm" | "default";
}) {
  const { t } = useTranslation("settings");
  const connect = useOAuthConnect();
  const disconnect = useOAuthDisconnect();
  const labelKey = oauthButtonLabelKey(status);
  // A token exists that the user may want to revoke outright instead of
  // renewing — offer Disconnect alongside Reconnect/Extend.
  const canDisconnect = status.kind === "expired" || status.kind === "expiring";

  if (labelKey !== null) {
    return (
      <div className="flex items-center gap-2">
        {canDisconnect ? (
          <Button
            type="button"
            variant="ghost"
            flush
            size={size}
            onClick={() => {
              void disconnect(entry.provider);
            }}
          >
            {t("connections.disconnect")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="subtle"
          size={size}
          onClick={() => {
            void connect(entry.provider);
          }}
        >
          {t(labelKey)}
        </Button>
      </div>
    );
  }

  if (status.kind === "active") {
    return (
      <div
        className="flex h-8 w-8 items-center justify-center text-success"
        role="img"
        aria-label={t("connections.status.active")}
        title={t("connections.status.active")}
      >
        <IconCheck className="size-4" aria-hidden="true" />
      </div>
    );
  }

  return null;
}

export function OAuthConnectionCard({
  entry,
  status,
}: {
  entry: OAuthProviderEntry;
  status: ConnectionStatus;
}) {
  return (
    <ConnectionCard
      icon={<entry.Icon className="h-4.5 w-4.5" />}
      name={entry.displayName}
      description={entry.description}
      badge={<OAuthStatusBadge status={status} />}
      action={<OAuthConnectionActions entry={entry} status={status} />}
    />
  );
}

export function isEditableExtension(extension: ExtensionEntry): boolean {
  return (
    (extension.type === "stdio" || extension.type === "streamable_http") &&
    !extension.bundled
  );
}

function extensionDescription(extension: ExtensionEntry): string {
  if (extension.description) return extension.description;
  if (extension.type === "stdio") return extension.cmd;
  if (extension.type === "streamable_http") return extension.uri;
  return extension.type;
}

export function ExtensionConnectionCard({
  extension,
  onReset,
  onSelect,
}: {
  extension: ExtensionEntry;
  onReset: (configKey: string) => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation("settings");
  const displayName = getDisplayName(extension);
  const editable = isEditableExtension(extension);
  const installed = !("bundled" in extension && extension.bundled === true);
  const showAlwaysOnWarning =
    extension.enabled && !isAlwaysOnAllowed(extension.config_key);

  return (
    <ConnectionCard
      icon={<Link2 className="size-4.5 text-foreground" aria-hidden="true" />}
      name={displayName}
      description={extensionDescription(extension)}
      badge={
        showAlwaysOnWarning ? (
          <span
            className="inline-flex items-center gap-1 text-xs text-warning"
            title={t("extensions.alwaysOn.tooltip")}
          >
            <IconAlertTriangle className="size-3.5" aria-hidden="true" />
            {t("extensions.alwaysOn.label")}
          </span>
        ) : null
      }
      action={
        <div className="flex items-center gap-1.5">
          {editable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSelect}
              aria-label={t("extensions.configure", { name: displayName })}
            >
              {t("connections.configure")}
            </Button>
          ) : null}
          {installed && showAlwaysOnWarning ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                onReset(extension.config_key);
              }}
              aria-label={t("extensions.alwaysOn.resetAria", {
                name: displayName,
              })}
              tooltip={t("extensions.alwaysOn.tooltip")}
            >
              {t("extensions.alwaysOn.reset")}
            </Button>
          ) : null}
          {installed ? (
            <div
              className="flex h-8 w-8 items-center justify-center text-success"
              role="img"
              aria-label={t("connections.status.active")}
              title={t("connections.status.active")}
            >
              <IconCheck className="size-4" aria-hidden="true" />
            </div>
          ) : null}
        </div>
      }
    />
  );
}
