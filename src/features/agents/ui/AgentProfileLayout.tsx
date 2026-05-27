import type { FormEventHandler, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

interface AgentProfileLayoutProps {
  animateSections?: boolean;
  bottomBar?: ReactNode;
  children: ReactNode;
  className?: string;
  fieldsTransitionName?: string;
  formId?: string;
  identityRail: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  sectionEnterClassName?: string;
}

const SURFACE_CLASS = cn(
  "agents-transition-surface relative min-h-full py-6 pl-6 pr-8",
  "bg-[radial-gradient(circle_at_1px_1px,var(--surface-agent-profile-dot)_1px,transparent_0)] bg-[length:32px_32px]",
);

function AgentProfileContent({
  animateSections = true,
  children,
  fieldsTransitionName,
  identityRail,
  sectionEnterClassName,
}: Omit<AgentProfileLayoutProps, "className" | "formId" | "onSubmit">) {
  const enterClassName =
    sectionEnterClassName ?? "agents-profile-section-enter";

  return (
    <div className="mx-auto flex min-h-[calc(100vh-var(--spacing-app-top-bar)-3rem)] w-full max-w-[1180px] flex-col justify-start gap-8 pb-20 pt-4">
      <div className="grid items-start gap-8 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,760px)]">
        <section
          data-agent-layout-slot="identity-rail"
          className={cn(
            "relative mx-auto flex w-full max-w-[280px] flex-col lg:max-w-none",
            animateSections && enterClassName,
          )}
          style={animateSections ? { animationDelay: "40ms" } : undefined}
        >
          {identityRail}
        </section>

        <div data-agent-layout-slot="content" className="min-w-0">
          <section
            data-agent-layout-slot="fields"
            className={cn(
              "min-w-0 space-y-5",
              animateSections && enterClassName,
            )}
            style={{
              ...(animateSections ? { animationDelay: "90ms" } : {}),
              ...(fieldsTransitionName
                ? { viewTransitionName: fieldsTransitionName }
                : {}),
            }}
          >
            {children}
          </section>
        </div>
      </div>
    </div>
  );
}

export function AgentProfileLayout({
  animateSections,
  bottomBar,
  children,
  className,
  fieldsTransitionName,
  formId,
  identityRail,
  onSubmit,
  sectionEnterClassName,
}: AgentProfileLayoutProps) {
  const content = (
    <AgentProfileContent
      animateSections={animateSections}
      fieldsTransitionName={fieldsTransitionName}
      identityRail={identityRail}
      sectionEnterClassName={sectionEnterClassName}
    >
      {children}
    </AgentProfileContent>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface-agent-profile-bg">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {onSubmit ? (
          <form
            id={formId}
            onSubmit={onSubmit}
            className={cn(SURFACE_CLASS, className)}
          >
            {content}
          </form>
        ) : (
          <div className={cn(SURFACE_CLASS, className)}>{content}</div>
        )}
      </div>
      {bottomBar ? (
        <div
          data-agent-layout-slot="bottom-bar-shell"
          className="shrink-0 bg-surface-agent-profile-bg/95 px-6 backdrop-blur-xl"
        >
          <div className="mx-auto grid w-full max-w-[1180px] items-center gap-8 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,760px)]">
            <div className="hidden md:block" aria-hidden="true" />
            <div
              data-agent-layout-slot="bottom-bar"
              className="border-t border-surface-agent-profile-border py-4"
            >
              {bottomBar}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
