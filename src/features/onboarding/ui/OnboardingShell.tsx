import { useEffect, useRef, type ReactNode } from "react";
import { IconChevronLeft } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

interface OnboardingShellProps {
  title?: ReactNode;
  description?: ReactNode;
  onBack?: () => void;
  backDisabled?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  contentClassName?: string;
}

export function OnboardingShell({
  title,
  description,
  onBack,
  backDisabled = false,
  children,
  actions,
  contentClassName,
}: OnboardingShellProps) {
  const { t } = useTranslation("onboarding");
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
    // Focus announces the newly mounted step. Subsequent title/status renders
    // must not steal focus from controls inside the step.
  }, []);
  return (
    <main className="relative flex h-screen w-full flex-col overflow-hidden bg-dot-grid text-foreground">
      <div
        className="absolute inset-x-0 top-0 z-10 h-[var(--spacing-app-top-bar)] select-none"
        data-tauri-drag-region="deep"
        aria-hidden="true"
      />
      {onBack ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBack}
          disabled={backDisabled}
          className="absolute top-14 left-5 z-20"
          aria-label={t("shell.goBack")}
        >
          <IconChevronLeft />
        </Button>
      ) : null}
      {title ? (
        <header className="relative z-10 mx-auto mt-16 max-w-2xl px-8 text-center">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-[30px] leading-[1.18] font-normal outline-none"
          >
            {title}
          </h1>
          {description ? (
            <div className="mt-2 text-sm leading-5">{description}</div>
          ) : null}
        </header>
      ) : null}
      <div
        className={cn(
          "relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-y-auto",
          contentClassName,
        )}
      >
        {children}
      </div>
      {actions ? (
        <div className="relative z-20 mx-auto mb-8 flex w-[230px] shrink-0 flex-col gap-3">
          {actions}
        </div>
      ) : null}
    </main>
  );
}
