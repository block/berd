import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import {
  ensureRemoteHostStoreInitialized,
  useRemoteHostStore,
  type RemoteHostStatus,
} from "@/features/remoteHosts/stores/remoteHostStore";
import {
  isRemoteBackendError,
  type RemoteToolProbe,
} from "@/shared/api/remoteHosts";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Input } from "@/shared/ui/input";
import { SettingsRow } from "@/shared/ui/settings-row";
import { SettingsSection } from "@/shared/ui/settings-section";

function StatusPill({ status }: { status: RemoteHostStatus | undefined }) {
  const { t } = useTranslation("settings");
  const state = status?.state ?? "disconnected";

  const label =
    state === "reconnecting" && status?.attempt !== undefined
      ? t("remoteHosts.status.reconnectingAttempt", { attempt: status.attempt })
      : t(`remoteHosts.status.${state}`);

  return (
    <Badge
      variant={state === "failed" ? "destructive" : "secondary"}
      className={cn(state === "ready" && "text-foreground")}
    >
      {label}
    </Badge>
  );
}

function DoctorReport({
  probes,
  pending,
  errorMessage,
}: {
  probes: RemoteToolProbe[] | undefined;
  pending: boolean;
  errorMessage: string | undefined;
}) {
  const { t } = useTranslation("settings");

  if (pending) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("remoteHosts.doctor.checking")}
      </p>
    );
  }
  if (errorMessage) {
    return <p className="text-xs text-destructive">{errorMessage}</p>;
  }
  if (!probes) return null;

  const gooseMissing = probes.some(
    (probe) => probe.binary === "goose" && !probe.found,
  );

  return (
    <div className="space-y-1">
      <ul className="space-y-0.5">
        {probes.map((probe) => (
          <li
            key={probe.binary}
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            <span className="font-mono text-foreground">{probe.binary}</span>
            <span>
              {probe.found
                ? (probe.version ?? t("remoteHosts.doctor.found"))
                : t("remoteHosts.doctor.notFound")}
            </span>
            {/* Which binary actually answered: confirms an override took. */}
            {probe.path ? (
              <span className="truncate font-mono">{probe.path}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {gooseMissing ? (
        <p className="text-xs text-muted-foreground">
          {t("remoteHosts.doctor.gooseMissing")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Optional per-host goose binary path. Empty means "resolve `goose` from the
 * ssh login PATH" (the default); a saved path is what the remote daemon runs
 * from the next connect on.
 */
function GooseBinaryOverride({ host }: { host: string }) {
  const { t } = useTranslation("settings");
  const inputId = useId();
  const savedPath = useRemoteHostStore((state) => state.goosePathByHost[host]);
  const setGoosePath = useRemoteHostStore((state) => state.setGoosePath);

  const [draft, setDraft] = useState(savedPath ?? "");
  const [error, setError] = useState<string | null>(null);

  // Follow the persisted value when it changes elsewhere (other settings
  // mount, another window) instead of stranding a stale draft.
  useEffect(() => {
    setDraft(savedPath ?? "");
    setError(null);
  }, [savedPath]);

  const save = () => {
    if (!setGoosePath(host, draft)) {
      setError(t("remoteHosts.gooseBinary.invalidError"));
      return;
    }
    setError(null);
  };

  const clear = () => {
    setGoosePath(host, null);
    setDraft("");
    setError(null);
  };

  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-xs text-muted-foreground">
        {t("remoteHosts.gooseBinary.label")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={draft}
          spellCheck={false}
          placeholder={t("remoteHosts.gooseBinary.placeholder")}
          className="h-8 w-64 font-mono text-xs"
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={save}>
          {t("remoteHosts.gooseBinary.save")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={savedPath === undefined && draft === ""}
          onClick={clear}
        >
          {t("remoteHosts.gooseBinary.clear")}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <p className="text-xs text-muted-foreground">
        {t("remoteHosts.gooseBinary.hint")}
      </p>
    </div>
  );
}

function RemoteHostRow({
  host,
  onRequestShutdown,
}: {
  host: string;
  onRequestShutdown: (target: ShutdownTarget) => void;
}) {
  const { t } = useTranslation("settings");
  const status = useRemoteHostStore((state) => state.statusByHost[host]);
  const probes = useRemoteHostStore((state) => state.doctorByHost[host]);
  const doctorPending = useRemoteHostStore(
    (state) => state.doctorPendingByHost[host] === true,
  );
  const doctorError = useRemoteHostStore(
    (state) => state.doctorErrorByHost[host],
  );
  const ensureHostConnected = useRemoteHostStore(
    (state) => state.ensureHostConnected,
  );
  const disconnect = useRemoteHostStore((state) => state.disconnect);
  const runDoctor = useRemoteHostStore((state) => state.runDoctor);
  const isManualHost = useRemoteHostStore((state) =>
    state.manualHosts.includes(host),
  );
  const removeManualHost = useRemoteHostStore(
    (state) => state.removeManualHost,
  );

  const state = status?.state ?? "disconnected";
  const isConnected = state === "ready" || state === "reconnecting";
  const failedMessage = state === "failed" ? status?.error?.message : undefined;
  const conflictInstance =
    status?.error?.kind === "daemon-conflict"
      ? status.error.daemonInstance
      : undefined;
  const isConflict = conflictInstance !== undefined;
  const showDoctor = doctorPending || doctorError !== undefined || !!probes;

  return (
    <SettingsRow
      align="start"
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{host}</span>
          <StatusPill status={status} />
        </span>
      }
      description={failedMessage}
      descriptionClassName="text-destructive"
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isConnected ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void disconnect(host).catch(() => {});
              }}
            >
              {t("remoteHosts.actions.disconnect")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={state === "connecting"}
              onClick={() => {
                // Failures surface via the store's failed status for this row.
                void ensureHostConnected(host).catch(() => {});
              }}
            >
              {state === "connecting"
                ? t("remoteHosts.status.connecting")
                : t("remoteHosts.actions.connect")}
            </Button>
          )}
          {state !== "connecting" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              destructive
              onClick={() =>
                onRequestShutdown({
                  host,
                  reconnect: isConflict,
                  instanceToken: conflictInstance?.instanceToken,
                })
              }
            >
              {isConflict
                ? t("remoteHosts.actions.takeover")
                : t("remoteHosts.actions.shutdown")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={doctorPending}
            onClick={() => {
              void runDoctor(host);
            }}
          >
            {t("remoteHosts.actions.check")}
          </Button>
          {isManualHost && !isConnected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeManualHost(host)}
            >
              {t("remoteHosts.actions.forget")}
            </Button>
          ) : null}
        </div>
      }
      details={
        <div className="space-y-3">
          {showDoctor ? (
            <DoctorReport
              probes={probes}
              pending={doctorPending}
              errorMessage={doctorError?.message}
            />
          ) : null}
          {conflictInstance ? (
            <p className="text-xs text-muted-foreground">
              {t("remoteHosts.conflict.instance", {
                pid: conflictInstance.pid,
                version: conflictInstance.gooseVersion,
                binary:
                  conflictInstance.binary ??
                  t("remoteHosts.conflict.pathUnknown"),
              })}
            </p>
          ) : null}
          <GooseBinaryOverride host={host} />
        </div>
      }
    />
  );
}

/**
 * Experiment-gated "Remote SSH hosts" card for the Settings connections
 * section: connect Berd to Goose daemons on hosts from `~/.ssh/config` (or a
 * free-form `user@host`), with per-host status and a tooling doctor.
 */
export function RemoteHostsSettings() {
  const { t } = useTranslation("settings");
  const enabled =
    useExperiment(REMOTE_SSH_SESSIONS_EXPERIMENT_ID)?.enabled === true;

  const configHosts = useRemoteHostStore((state) => state.configHosts);
  const manualHosts = useRemoteHostStore((state) => state.manualHosts);
  const statusByHost = useRemoteHostStore((state) => state.statusByHost);
  const ensureHostConnected = useRemoteHostStore(
    (state) => state.ensureHostConnected,
  );
  const shutdownHost = useRemoteHostStore((state) => state.shutdownHost);

  const [customHost, setCustomHost] = useState("");
  const [customHostError, setCustomHostError] = useState<string | null>(null);
  const [customHostConnecting, setCustomHostConnecting] = useState(false);
  const [shutdownTarget, setShutdownTarget] = useState<ShutdownTarget | null>(
    null,
  );
  const [shutdownPending, setShutdownPending] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    // Init subscribes to live status events and seeds snapshot + config
    // hosts; when it already ran (startup or an earlier mount), re-refresh so
    // this mount shows current data.
    if (!ensureRemoteHostStoreInitialized()) {
      const store = useRemoteHostStore.getState();
      void store.refreshConfigHosts();
      void store.syncBackendSnapshot();
    }
  }, [enabled]);

  // Config hosts first, then manually added hosts (persisted across
  // restarts), then any other ad-hoc hosts we have status for this run.
  const hosts = useMemo(() => {
    const extra = [...manualHosts, ...Object.keys(statusByHost).sort()].filter(
      (host, index, all) =>
        !configHosts.includes(host) && all.indexOf(host) === index,
    );
    return [...configHosts, ...extra];
  }, [configHosts, manualHosts, statusByHost]);

  if (!enabled) return null;

  const connectCustomHost = async () => {
    const trimmed = customHost.trim();
    if (!trimmed) {
      setCustomHostError(t("remoteHosts.custom.emptyError"));
      return;
    }
    setCustomHostError(null);
    setCustomHostConnecting(true);
    try {
      await ensureHostConnected(trimmed);
      setCustomHost("");
    } catch (error) {
      setCustomHostError(
        isRemoteBackendError(error) ? error.message : String(error),
      );
    } finally {
      setCustomHostConnecting(false);
    }
  };

  return (
    <SettingsSection title={t("remoteHosts.title")}>
      <p className="pb-3 text-xs text-muted-foreground">
        {t("remoteHosts.description")}
      </p>
      {hosts.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          {t("remoteHosts.empty")}
        </p>
      ) : (
        hosts.map((host) => (
          <RemoteHostRow
            key={host}
            host={host}
            onRequestShutdown={setShutdownTarget}
          />
        ))
      )}
      <SettingsRow
        label={t("remoteHosts.custom.label")}
        description={t("remoteHosts.custom.description")}
        action={({ labelId }) => (
          <div className="flex items-center gap-2">
            <Input
              value={customHost}
              aria-labelledby={labelId}
              placeholder={t("remoteHosts.custom.placeholder")}
              className="h-8 w-48"
              onChange={(event) => setCustomHost(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void connectCustomHost();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={customHostConnecting}
              onClick={() => {
                void connectCustomHost();
              }}
            >
              {customHostConnecting
                ? t("remoteHosts.status.connecting")
                : t("remoteHosts.actions.connect")}
            </Button>
          </div>
        )}
        details={
          customHostError ? (
            <p className="text-xs text-destructive">{customHostError}</p>
          ) : undefined
        }
      />
      <ConfirmDialog
        open={shutdownTarget !== null}
        onOpenChange={(open) => {
          if (!open) setShutdownTarget(null);
        }}
        title={t("remoteHosts.shutdownConfirm.title", {
          host: shutdownTarget?.host ?? "",
        })}
        description={t(
          shutdownTarget?.reconnect
            ? "remoteHosts.takeoverConfirm.description"
            : "remoteHosts.shutdownConfirm.description",
        )}
        cancelLabel={t("remoteHosts.shutdownConfirm.cancel")}
        confirmLabel={t("remoteHosts.shutdownConfirm.confirm")}
        loadingLabel={t("remoteHosts.shutdownConfirm.stopping")}
        isLoading={shutdownPending}
        onConfirm={async () => {
          if (shutdownTarget === null) return;
          setShutdownPending(true);
          try {
            if (shutdownTarget.instanceToken) {
              await shutdownHost(
                shutdownTarget.host,
                shutdownTarget.instanceToken,
              );
            } else {
              await shutdownHost(shutdownTarget.host);
            }
            if (shutdownTarget.reconnect) {
              await ensureHostConnected(shutdownTarget.host);
            }
            setShutdownTarget(null);
          } finally {
            setShutdownPending(false);
          }
        }}
        onConfirmError={() => {
          // The store keeps the previous status; the row remains actionable.
        }}
      />
    </SettingsSection>
  );
}

interface ShutdownTarget {
  host: string;
  reconnect: boolean;
  instanceToken?: string;
}
