import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import {
  cancelLogin,
  startLogin,
  type AuthStatus,
} from "@/features/auth/api/auth";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { avatarRef } from "@/shared/avatars/catalog";
import { useAvatarImage, useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import { cn } from "@/shared/lib/cn";
import { AvatarMedia } from "@/shared/ui/avatar-media";
import { Button } from "@/shared/ui/button";
import { GooseIcon } from "@/shared/ui/icons/GooseIcon";
import { Input } from "@/shared/ui/input";

interface LoginViewProps {
  authStatus?: AuthStatus;
  statusError?: Error;
  onRetryStatus: () => void;
  onAuthenticated: (status: AuthStatus) => void;
}

interface LoginAvatarSlot {
  id: string;
  left: number;
  top: number;
  size: number;
  mobile?: {
    left: number;
    top: number;
    size: number;
  };
}

type LoginAvatarStyle = CSSProperties & Record<`--${string}`, string | number>;

const LOGIN_UI_TRANSITION_MS = 200;

const LOGIN_AVATARS: LoginAvatarSlot[] = [
  {
    id: "pollies-22",
    left: 7.5,
    top: 22.4,
    size: 19.6,
    mobile: { left: 10, top: 9, size: 72 },
  },
  {
    id: "fuzzies-3",
    left: 3,
    top: 65.6,
    size: 13.5,
  },
  {
    id: "pollies-2",
    left: 12.2,
    top: 93.5,
    size: 13.75,
    mobile: { left: 10, top: 95, size: 68 },
  },
  {
    id: "pollies-21",
    left: 22.8,
    top: 44,
    size: 13.75,
  },
  {
    id: "gloopies-6",
    left: 24.6,
    top: 7.9,
    size: 11,
  },
  {
    id: "fuzzies-18",
    left: 29.7,
    top: 77.6,
    size: 21.3,
    mobile: { left: 90, top: 95, size: 74 },
  },
  {
    id: "gloopies-1",
    left: 40,
    top: 14,
    size: 13.3,
    mobile: { left: 50, top: 4, size: 64 },
  },
  {
    id: "fuzzies-8",
    left: 60,
    top: 16,
    size: 13.75,
  },
  {
    id: "pollies-10",
    left: 69,
    top: 80,
    size: 13.75,
    mobile: { left: 66, top: 96, size: 58 },
  },
  {
    id: "gloopies-14",
    left: 80,
    top: 9,
    size: 19,
    mobile: { left: 90, top: 9, size: 72 },
  },
  {
    id: "gloopies-9",
    left: 76,
    top: 47,
    size: 10.6,
  },
  {
    id: "fuzzies-2",
    left: 97,
    top: 18,
    size: 11,
  },
  {
    id: "fuzzies-12",
    left: 94,
    top: 63,
    size: 19.8,
  },
  {
    id: "gloopies-5",
    left: 88,
    top: 91,
    size: 11,
  },
];

function getReducedMotionMediaQuery() {
  if (typeof window.matchMedia !== "function") {
    return null;
  }

  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    () => getReducedMotionMediaQuery()?.matches ?? false,
  );

  const prefersReducedMotionRef = useRef(prefersReducedMotion);

  useEffect(() => {
    const mediaQuery = getReducedMotionMediaQuery();
    if (!mediaQuery) {
      return;
    }

    const handleChange = () => {
      prefersReducedMotionRef.current = mediaQuery.matches;
      setPrefersReducedMotion(mediaQuery.matches);
    };
    if (mediaQuery.matches !== prefersReducedMotionRef.current) {
      handleChange();
    }
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
}

function useTransitionPresence(present: boolean, durationMs: number) {
  const [shouldRender, setShouldRender] = useState(present);

  useEffect(() => {
    if (present) {
      setShouldRender(true);
      return;
    }

    if (durationMs <= 0) {
      setShouldRender(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
    }, durationMs);

    return () => window.clearTimeout(timeoutId);
  }, [durationMs, present]);

  return shouldRender;
}

function LoginTransitionSlot({
  children,
  className,
  durationMs,
  present,
}: {
  children: ReactNode;
  className?: string;
  durationMs: number;
  present: boolean;
}) {
  const shouldRender = useTransitionPresence(present, durationMs);

  if (!shouldRender) {
    return null;
  }

  return (
    <div
      aria-hidden={present ? undefined : true}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,transform] ease-out motion-reduce:transition-none",
        present
          ? "grid-rows-[1fr] translate-y-0 opacity-100"
          : "grid-rows-[0fr] -translate-y-1 opacity-0",
        className,
      )}
      style={{ transitionDuration: `${durationMs}ms` }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function avatarStyle(slot: LoginAvatarSlot): LoginAvatarStyle {
  const style: LoginAvatarStyle = {
    "--l": slot.left,
    "--t": slot.top,
    "--s": slot.size,
  };

  if (slot.mobile) {
    style["--ml"] = slot.mobile.left;
    style["--mt"] = slot.mobile.top;
    style["--ms"] = slot.mobile.size;
  }

  return style;
}

function LoginAvatarField() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
      data-login-avatar-layer
    >
      {LOGIN_AVATARS.map((slot) => (
        <LoginAvatar key={slot.id} slot={slot} />
      ))}
    </div>
  );
}

function LoginAvatar({ slot }: { slot: LoginAvatarSlot }) {
  const ref = avatarRef(slot.id);
  const media = useAvatarMedia(ref);
  const image = useAvatarImage(ref);

  return (
    <div
      className={cn(
        "absolute left-[calc(var(--l)*1%)] top-[calc(var(--t)*1%)] aspect-square w-[clamp(72px,calc(var(--s)*0.82vw),248px)] -translate-x-1/2 -translate-y-1/2 select-none opacity-90",
        slot.mobile
          ? "max-[680px]:left-[calc(var(--ml)*1%)] max-[680px]:top-[calc(var(--mt)*1%)] max-[680px]:w-[calc(var(--ms)*1px)] max-[680px]:opacity-95"
          : "max-[680px]:hidden",
      )}
      style={avatarStyle(slot)}
      data-login-avatar={slot.id}
      data-login-avatar-mobile={slot.mobile ? "true" : undefined}
    >
      {media ? (
        <AvatarMedia
          media={media}
          alt=""
          loadingStrategy="visible-video"
          poster={image}
          className="pointer-events-none h-full w-full object-contain"
        />
      ) : image ? (
        <img
          aria-hidden="true"
          alt=""
          src={image}
          className="pointer-events-none h-full w-full object-contain"
        />
      ) : null}
    </div>
  );
}

export function LoginView({
  authStatus,
  statusError,
  onRetryStatus,
  onAuthenticated,
}: LoginViewProps) {
  const [org, setOrg] = useState(authStatus?.org ?? "");
  const [pending, setPending] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const loginAttemptRef = useRef(0);
  const previousAuthOrgRef = useRef(authStatus?.org ?? "");
  const canSubmit = !pending && org.trim().length > 0;
  const transitionDurationMs = prefersReducedMotion
    ? 0
    : LOGIN_UI_TRANSITION_MS;

  useEffect(() => {
    const nextAuthOrg = authStatus?.org ?? "";
    if (previousAuthOrgRef.current === nextAuthOrg) {
      return;
    }

    previousAuthOrgRef.current = nextAuthOrg;
    setOrg(nextAuthOrg);
  }, [authStatus?.org]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    const loginAttempt = loginAttemptRef.current + 1;
    loginAttemptRef.current = loginAttempt;
    setPending(true);
    try {
      const nextStatus = await startLogin(org);
      if (loginAttemptRef.current !== loginAttempt) return;

      onAuthenticated(nextStatus);
      if (!nextStatus.loggedIn) {
        toast.error("Sign-in did not complete.");
      }
    } catch (error) {
      if (loginAttemptRef.current !== loginAttempt) return;

      toast.error(formatAcpErrorMessage(error, "Failed to sign in"));
    } finally {
      if (loginAttemptRef.current === loginAttempt) {
        setPending(false);
      }
    }
  }

  async function handleCancelLogin() {
    loginAttemptRef.current += 1;
    setPending(false);
    try {
      await cancelLogin();
    } catch (error) {
      console.warn("Failed to cancel login:", error);
    }
  }

  return (
    <main
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-dot-grid px-6 text-foreground"
      data-tauri-drag-region
    >
      <LoginAvatarField />
      <section
        className={cn(
          "relative z-10 flex w-full max-w-sm flex-col items-center text-center transition-[opacity,transform] duration-300 ease-out motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:zoom-in-95 motion-safe:duration-300 motion-reduce:animate-none motion-reduce:transition-none",
          pending ? "-translate-y-1" : "translate-y-0",
        )}
        data-tauri-drag-region
      >
        <GooseIcon
          className={cn(
            "mb-8 size-16 text-foreground transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
            pending ? "scale-95 opacity-80" : "scale-100 opacity-100",
          )}
        />
        <h1 className="font-medium text-5xl tracking-normal transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none">
          Goose
        </h1>

        <form
          className={cn(
            "mt-8 flex w-full max-w-72 flex-col gap-3 transition-[transform] duration-300 ease-out motion-reduce:transition-none",
            pending ? "-translate-y-0.5" : "translate-y-0",
          )}
          onSubmit={handleLogin}
        >
          <div className="flex flex-col gap-1.5 text-left">
            <label
              className="px-1 text-muted-foreground text-xs"
              htmlFor="login-org"
            >
              Organization
            </label>
            <Input
              id="login-org"
              autoCapitalize="none"
              autoCorrect="off"
              className="transition-[opacity,transform,border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none"
              disabled={pending}
              placeholder="e.g. test"
              spellCheck={false}
              value={org}
              onChange={(event) => setOrg(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="lg"
            className="w-full transition-[transform,background-color,color,opacity] duration-200 ease-out motion-reduce:transition-none data-[feedback-state=loading]:scale-[0.99]"
            feedbackState={pending ? "loading" : "idle"}
            loadingLabel="Signing in..."
            preserveWidth
            disabled={!canSubmit}
          >
            Log In
          </Button>
          <LoginTransitionSlot
            className="justify-items-center"
            durationMs={transitionDurationMs}
            present={pending}
          >
            <Button
              type="button"
              variant="ghost"
              flush
              size="xs"
              className="self-center"
              disabled={!pending}
              leftIcon={<XIcon aria-hidden="true" />}
              tabIndex={pending ? undefined : -1}
              onClick={() => void handleCancelLogin()}
            >
              Cancel
            </Button>
          </LoginTransitionSlot>
        </form>

        <LoginTransitionSlot
          durationMs={transitionDurationMs}
          present={Boolean(statusError)}
        >
          <div className="mt-5 flex max-w-xs flex-col items-center gap-2 text-muted-foreground text-xs">
            <p>Couldn't check sign-in status.</p>
            <Button
              type="button"
              variant="ghost"
              flush
              size="xs"
              leftIcon={<RotateCcwIcon aria-hidden="true" />}
              tabIndex={statusError ? undefined : -1}
              onClick={onRetryStatus}
            >
              Retry
            </Button>
          </div>
        </LoginTransitionSlot>
      </section>
    </main>
  );
}
