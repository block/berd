import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { cn } from "@/shared/lib/cn";
import { Button, type ButtonProps, buttonVariants } from "@/shared/ui/button";

const toastActionButtonLayoutClassName = "ml-auto shrink-0";

const toastActionButtonClassName = buttonVariants({
  size: "xxs",
  className: cn(
    toastActionButtonLayoutClassName,
    "relative select-none cursor-pointer",
    "!bg-primary !text-primary-foreground hover:!bg-primary/90 focus-visible:!ring-2 focus-visible:!ring-ring",
  ),
});

type ToastActionButtonProps = Omit<ButtonProps, "size" | "variant"> & {
  emphasis?: "primary" | "secondary";
};

const Toaster = ({ ...props }: ToasterProps) => {
  const { isDark } = useTheme();

  return (
    <Sonner
      theme={isDark ? "dark" : "light"}
      className="toaster group"
      position="bottom-right"
      expand
      visibleToasts={3}
      gap={8}
      swipeDirections={["right", "bottom"]}
      offset={{ bottom: "var(--toast-bottom-offset)", right: 12 }}
      mobileOffset={{
        bottom: "var(--toast-mobile-bottom-offset)",
        left: 16,
        right: 16,
      }}
      style={
        {
          "--normal-bg": "var(--surface-composer-glass)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-md)",
        } as React.CSSProperties
      }
      toastOptions={{
        style: {
          backdropFilter: "var(--backdrop-composer-glass)",
          boxShadow: "var(--shadow-popover)",
          WebkitBackdropFilter: "var(--backdrop-composer-glass)",
        },
        classNames: {
          toast: "select-none cursor-pointer",
          content: "select-none cursor-pointer",
          title: "select-none cursor-pointer",
          description: "select-none cursor-pointer",
          actionButton: toastActionButtonClassName,
        },
      }}
      {...props}
    />
  );
};

function ToastActionButton({
  className,
  emphasis = "primary",
  type = "button",
  ...props
}: ToastActionButtonProps) {
  const variant =
    emphasis === "secondary" ? "quiet-inverse" : "composer-action";

  return (
    <Button
      {...props}
      type={type}
      variant={variant}
      size="xxs"
      className={cn(
        toastActionButtonLayoutClassName,
        "relative select-none cursor-pointer",
        className,
      )}
    >
      <span aria-hidden="true" className="invisible select-none">
        {props.children}
      </span>
      <span className="absolute inset-0 flex select-none cursor-pointer items-center justify-center">
        {props.children}
      </span>
    </Button>
  );
}

function ToastActionGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">{children}</div>
  );
}

export { Toaster, ToastActionButton, ToastActionGroup };
