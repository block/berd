import { Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { McpInventoryGroup } from "@/features/connections/lib/localMcpInventory";
import { HARNESS_LABELS } from "@/features/connections/lib/localMcpInventory";
import { ConnectionCard } from "./ConnectionCard";

export function LocalMcpConnectionCard({
  group,
}: {
  group: McpInventoryGroup;
}) {
  const { t } = useTranslation("settings");
  const harnesses = group.harnesses
    .map((harness) => HARNESS_LABELS[harness])
    .join(", ");

  return (
    <ConnectionCard
      icon={<Link2 aria-hidden="true" />}
      name={group.displayName}
      description={t("connections.worksWith", { harnesses })}
    />
  );
}
