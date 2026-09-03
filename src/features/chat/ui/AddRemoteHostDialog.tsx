import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";
import { isRemoteBackendError } from "@/shared/api/remoteHosts";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";

interface AddRemoteHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (host: string) => void;
}

export function AddRemoteHostDialog({
  open,
  onOpenChange,
  onConnected,
}: AddRemoteHostDialogProps) {
  const { t } = useTranslation("chat");
  const [hostDraft, setHostDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attemptRef = useRef(0);

  useEffect(
    () => () => {
      attemptRef.current += 1;
    },
    [],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      // The backend connection may still finish, but closing the dialog must
      // keep that late result from changing the composer's selected host.
      attemptRef.current += 1;
      setHostDraft("");
      setError(null);
      setPending(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;

    const host = hostDraft.trim();
    if (!host) {
      setError(t("toolbar.remoteHost.add.emptyHost"));
      return;
    }

    setError(null);
    setPending(true);
    const attempt = ++attemptRef.current;
    try {
      const outcome = await useRemoteHostStore
        .getState()
        .ensureHostConnected(host);
      if (attemptRef.current !== attempt) return;
      if (outcome === "superseded") {
        setError(t("toolbar.remoteHost.add.superseded"));
        return;
      }
      onConnected(host);
      handleOpenChange(false);
    } catch (connectionError) {
      if (attemptRef.current !== attempt) return;
      setError(
        isRemoteBackendError(connectionError)
          ? connectionError.message
          : String(connectionError),
      );
    } finally {
      if (attemptRef.current === attempt) {
        setPending(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md" closeLabel={t("toolbar.remoteHost.add.close")}>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("toolbar.remoteHost.add.title")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.remoteHost.add.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="add-ssh-environment-host">
              {t("toolbar.remoteHost.add.hostLabel")}
            </Label>
            <Input
              id="add-ssh-environment-host"
              value={hostDraft}
              placeholder={t("toolbar.remoteHost.add.hostPlaceholder")}
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "add-ssh-environment-error" : undefined}
              onChange={(event) => {
                setHostDraft(event.target.value);
                if (error) setError(null);
              }}
            />
            {error ? (
              <p
                id="add-ssh-environment-error"
                className="text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              {t("toolbar.remoteHost.add.cancel")}
            </Button>
            <Button
              type="submit"
              feedbackState={pending ? "loading" : "idle"}
              loadingLabel={t("toolbar.remoteHost.status.connecting")}
              preserveWidth
            >
              {t("toolbar.remoteHost.add.connect")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
