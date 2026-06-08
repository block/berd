import type React from "react";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastActionButton, ToastActionGroup } from "@/shared/ui/sonner";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  toastCustom: vi.fn(),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(mocks.toast, {
    custom: (...args: unknown[]) => mocks.toastCustom(...args),
    dismiss: (...args: unknown[]) => mocks.toastDismiss(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  }),
}));

import {
  getCompletionToastDescription,
  showCompletionNotificationToast,
} from "./CompletionNotificationToast";

function expectDesignSystemToastAction(
  action: unknown,
): asserts action is React.ReactElement<{
  children: React.ReactNode;
  onClick?: () => void;
}> {
  expect(isValidElement(action)).toBe(true);
  if (!isValidElement(action)) return;

  expect(action.type).toBe(ToastActionButton);
  expect(action.props).toEqual(
    expect.objectContaining({
      children: "View",
    }),
  );
}

describe("getCompletionToastDescription", () => {
  it("returns compact helper copy for each completion outcome", () => {
    expect(getCompletionToastDescription("completed")).toBe(
      "Agent response complete",
    );
    expect(getCompletionToastDescription("error")).toBe(
      "Agent response needs attention",
    );
    expect(getCompletionToastDescription("stopped")).toBe(
      "Agent response stopped",
    );
  });
});

describe("CompletionNotificationToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the shared Toaster-backed Sonner toast for completed responses", () => {
    const onView = vi.fn();
    mocks.toast.mockReturnValue("completion-toast-id");

    showCompletionNotificationToast({
      title: "Review fixes finished",
      outcome: "completed",
      onView,
    });

    expect(mocks.toast).toHaveBeenCalledWith(
      "Review fixes finished",
      expect.objectContaining({
        description: "Agent response complete",
      }),
    );
    expect(mocks.toastCustom).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();

    const options = mocks.toast.mock.calls[0]?.[1] as {
      action?: unknown;
    };
    expectDesignSystemToastAction(options.action);
    options.action.props.onClick?.();

    expect(mocks.toastDismiss).toHaveBeenCalledWith("completion-toast-id");
    expect(onView).toHaveBeenCalledOnce();
  });

  it("uses the shared Toaster-backed error toast for error responses", () => {
    const onView = vi.fn();
    mocks.toastError.mockReturnValue("error-toast-id");

    showCompletionNotificationToast({
      title: "Review fixes encountered an error",
      outcome: "error",
      onView,
    });

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Review fixes encountered an error",
      expect.objectContaining({
        description: "Agent response needs attention",
      }),
    );
    const options = mocks.toastError.mock.calls[0]?.[1] as {
      action?: unknown;
    };
    expectDesignSystemToastAction(options.action);
    options.action.props.onClick?.();

    expect(mocks.toastDismiss).toHaveBeenCalledWith("error-toast-id");
    expect(onView).toHaveBeenCalledOnce();
    expect(mocks.toastCustom).not.toHaveBeenCalled();
  });

  it("adds a secondary Change sound action when provided", () => {
    const onView = vi.fn();
    const onChangeSound = vi.fn();
    mocks.toast.mockReturnValue("completion-toast-id");

    showCompletionNotificationToast({
      title: "Review fixes finished",
      outcome: "completed",
      onView,
      onChangeSound,
    });

    const options = mocks.toast.mock.calls[0]?.[1] as {
      action?: unknown;
    };
    expect(isValidElement(options.action)).toBe(true);
    if (!isValidElement(options.action)) return;

    const action = options.action as React.ReactElement<{
      children: [
        React.ReactElement<{
          onClick?: () => void;
          children: React.ReactNode;
        }>,
        React.ReactElement<{
          onClick?: () => void;
          children: React.ReactNode;
        }>,
      ];
    }>;
    expect(action.type).toBe(ToastActionGroup);
    const [changeSoundAction, viewAction] = action.props.children;

    expect(changeSoundAction.type).toBe(ToastActionButton);
    expect(changeSoundAction.props.children).toBe("Change sound");
    expect(viewAction.type).toBe(ToastActionButton);
    expect(viewAction.props.children).toBe("View");

    changeSoundAction.props.onClick?.();

    expect(mocks.toastDismiss).toHaveBeenCalledWith("completion-toast-id");
    expect(onChangeSound).toHaveBeenCalledOnce();
    expect(onView).not.toHaveBeenCalled();
  });
});
