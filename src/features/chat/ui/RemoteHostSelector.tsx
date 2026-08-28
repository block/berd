import { Laptop, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ChatInputSelector,
  type ChatInputSelectorItem,
} from "./ChatInputSelector";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";

const LOCAL_HOST_VALUE = "__local__";

interface RemoteHostSelectorProps {
  selectedHost?: string | null;
  /** SSH host aliases to offer; defaults to the remote-host store's list. */
  hosts?: string[];
  onHostChange?: (host: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRequestComposerFocus?: () => void;
  triggerIconOnly?: boolean;
  disabled?: boolean;
  modal?: boolean;
}

export function RemoteHostSelector({
  selectedHost = null,
  hosts,
  onHostChange,
  open,
  onOpenChange,
  onRequestComposerFocus,
  triggerIconOnly,
  disabled,
  modal,
}: RemoteHostSelectorProps) {
  const { t } = useTranslation("chat");
  const configHosts = useRemoteHostStore((state) => state.configHosts);
  const manualHosts = useRemoteHostStore((state) => state.manualHosts);
  const statusByHost = useRemoteHostStore((state) => state.statusByHost);
  const baseHosts = hosts ?? configHosts;
  // Hosts added manually (persisted) or connected ad hoc this run don't
  // appear in ~/.ssh/config — wildcard-only configs like `Host *.blox` rely
  // on this.
  const extraHosts = [...manualHosts, ...Object.keys(statusByHost)].filter(
    (host, index, all) =>
      !baseHosts.includes(host) && all.indexOf(host) === index,
  );
  const availableHosts = [...baseHosts, ...extraHosts];
  // A stale selection (host removed from ~/.ssh/config) still needs a row so
  // the trigger label and check mark stay truthful.
  const listedHosts =
    selectedHost && !availableHosts.includes(selectedHost)
      ? [selectedHost, ...availableHosts]
      : availableHosts;

  const statusDescription = (host: string): string | undefined => {
    const state = statusByHost[host]?.state;
    return state ? t(`toolbar.remoteHost.status.${state}`) : undefined;
  };

  const hostItems: ChatInputSelectorItem[] = listedHosts.map((host) => ({
    value: host,
    label: host,
    description: statusDescription(host),
    icon: <Server className="size-4 text-foreground" />,
  }));

  const handleValueChange = (value: string) => {
    onHostChange?.(value === LOCAL_HOST_VALUE ? null : value);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      // The SSH config can change while the app runs; refresh lazily on open.
      void useRemoteHostStore.getState().refreshConfigHosts();
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <ChatInputSelector
      ariaLabel={t("toolbar.remoteHost.selectHost")}
      value={selectedHost ?? LOCAL_HOST_VALUE}
      triggerLabel={selectedHost ?? t("toolbar.remoteHost.thisComputer")}
      triggerTitle={
        selectedHost
          ? t("toolbar.remoteHost.remoteTriggerTitle", { host: selectedHost })
          : t("toolbar.remoteHost.localTriggerTitle")
      }
      icon={
        selectedHost ? (
          <Server className="size-4" />
        ) : (
          <Laptop className="size-4" />
        )
      }
      open={open}
      onOpenChange={handleOpenChange}
      onRequestComposerFocus={onRequestComposerFocus}
      triggerIconOnly={triggerIconOnly}
      triggerVariant="toolbar"
      menuLabel={t("toolbar.remoteHost.chooseHost")}
      contentWidth="wide"
      disabled={disabled}
      modal={modal}
      sections={[
        {
          items: [
            {
              value: LOCAL_HOST_VALUE,
              label: t("toolbar.remoteHost.thisComputer"),
              description: t("toolbar.remoteHost.thisComputerDescription"),
              icon: <Laptop className="size-4 text-foreground" />,
            },
          ],
        },
        ...(hostItems.length > 0
          ? [
              {
                label: t("toolbar.remoteHost.sshHosts"),
                items: hostItems,
              },
            ]
          : []),
      ]}
      onValueChange={handleValueChange}
    />
  );
}
