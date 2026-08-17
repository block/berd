import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

interface AgentIdentityMetadataItem {
  label: string;
  value: string;
  /** Breaks anywhere, for unbroken strings like file paths. */
  wrap?: boolean;
  /** Wraps at word boundaries, for real prose like a description. */
  multiline?: boolean;
}

interface AgentIdentityRailProps {
  actions?: ReactNode;
  avatar?: ReactNode;
  className?: string;
  description?: ReactNode;
  leadingControl?: ReactNode;
  metadata?: AgentIdentityMetadataItem[];
  modeControl?: ReactNode;
  title?: ReactNode;
}

export function AgentIdentityRail({
  actions,
  avatar,
  className,
  description,
  leadingControl,
  metadata = [],
  modeControl,
  title,
}: AgentIdentityRailProps) {
  return (
    <div className={cn("w-full space-y-5", className)}>
      {leadingControl ? <div>{leadingControl}</div> : null}

      {avatar ? <div data-agent-layout-slot="avatar">{avatar}</div> : null}

      <div className="space-y-4">
        {title || description ? (
          <div className="space-y-2">
            {title ? (
              <h1 className="break-words text-base font-normal leading-5 text-surface-agent-profile-fg">
                {title}
              </h1>
            ) : null}
            {description ? (
              <div className="text-sm font-normal leading-relaxed text-surface-agent-profile-fg-muted">
                {description}
              </div>
            ) : null}
          </div>
        ) : null}

        {modeControl ? <div>{modeControl}</div> : null}

        {metadata.length > 0 ? (
          <dl className="grid gap-3 border-t border-surface-agent-profile-border pt-4">
            {metadata.map((item) => (
              <div key={item.label} className="min-w-0 space-y-1">
                <dt className="text-sm leading-5 font-normal text-surface-agent-profile-fg-muted">
                  {item.label}
                </dt>
                <dd
                  className={cn(
                    "text-[14px] leading-5 text-surface-agent-profile-fg-80",
                    item.multiline
                      ? "whitespace-pre-line break-words"
                      : item.wrap
                        ? "break-all"
                        : "truncate",
                  )}
                >
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
