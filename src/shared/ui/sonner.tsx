import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { buttonVariants } from "@/shared/ui/button";

const toastActionButtonClassName = buttonVariants({
  size: "xxs",
  className:
    "!rounded-full !bg-primary !text-primary-foreground hover:!bg-primary/90 focus-visible:!ring-2 focus-visible:!ring-ring",
});

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
          "--border-radius": "var(--radius-card-chat)",
        } as React.CSSProperties
      }
      toastOptions={{
        style: {
          backdropFilter: "var(--backdrop-composer-glass)",
          boxShadow: "var(--shadow-popover)",
          WebkitBackdropFilter: "var(--backdrop-composer-glass)",
        },
        classNames: {
          actionButton: toastActionButtonClassName,
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
