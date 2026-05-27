import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/shared/theme/ThemeProvider";

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
      offset={{ bottom: 88, right: 12 }}
      mobileOffset={{ bottom: 132, left: 16, right: 16 }}
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
      }}
      {...props}
    />
  );
};

export { Toaster };
