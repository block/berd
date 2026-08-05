import type { ReactNode } from "react";
import { SettingsRow } from "@/shared/ui/settings-row";

interface ConnectionCardProps {
  icon: ReactNode;
  name: string;
  description?: ReactNode;
  // Inline status chip rendered right after the name (expiry badge,
  // always-on warning, ...).
  badge?: ReactNode;
  // Connection-specific affordances such as Connect, Disconnect, or Configure.
  action?: ReactNode;
  className?: string;
}

/** Shared row shell for Connections. Only explicit actions are interactive. */
export function ConnectionCard({
  icon,
  name,
  description,
  badge,
  action,
  className,
}: ConnectionCardProps) {
  return (
    <SettingsRow
      className={className}
      leading={
        <div className="flex h-6 w-6 items-center justify-center">{icon}</div>
      }
      label={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{name}</span>
          {badge ? <span className="shrink-0">{badge}</span> : null}
        </span>
      }
      description={description}
      action={action}
    />
  );
}
