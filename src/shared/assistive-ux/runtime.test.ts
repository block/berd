import { beforeEach, describe, expect, it } from "vitest";
import { ASSISTIVE_UX_STORAGE_KEY, ASSISTIVE_UX_RULES } from "./registry";
import {
  recordAssistiveMomentAccepted,
  recordAssistiveMomentRetired,
  recordAssistiveMomentShown,
  shouldShowAssistiveMoment,
} from "./runtime";

const changeSoundId = ASSISTIVE_UX_RULES.notificationsChangeSound.id;

describe("Assistive UX runtime", () => {
  beforeEach(() => {
    window.localStorage.removeItem(ASSISTIVE_UX_STORAGE_KEY);
  });

  it("shows a fresh discover moment", () => {
    expect(shouldShowAssistiveMoment(changeSoundId)).toBe(true);
  });

  it("stops showing after the discover moment reaches its show limit", () => {
    recordAssistiveMomentShown(changeSoundId);
    recordAssistiveMomentShown(changeSoundId);
    expect(shouldShowAssistiveMoment(changeSoundId)).toBe(true);

    recordAssistiveMomentShown(changeSoundId);

    expect(shouldShowAssistiveMoment(changeSoundId)).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}")
        .moments[changeSoundId].retiredReason,
    ).toBe("expired");
  });

  it("retires a moment when accepted", () => {
    recordAssistiveMomentShown(changeSoundId);
    recordAssistiveMomentAccepted(changeSoundId);

    expect(shouldShowAssistiveMoment(changeSoundId)).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}")
        .moments[changeSoundId].retiredReason,
    ).toBe("accepted");
  });

  it("keeps acceptance as the final reason when an expired visible moment is accepted", () => {
    recordAssistiveMomentShown(changeSoundId);
    recordAssistiveMomentShown(changeSoundId);
    recordAssistiveMomentShown(changeSoundId);
    recordAssistiveMomentAccepted(changeSoundId);

    expect(
      JSON.parse(window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}")
        .moments[changeSoundId].retiredReason,
    ).toBe("accepted");
  });

  it("retires a moment with a caller-provided reason", () => {
    recordAssistiveMomentRetired(changeSoundId, "settingsChanged");

    expect(shouldShowAssistiveMoment(changeSoundId)).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}")
        .moments[changeSoundId].retiredReason,
    ).toBe("settingsChanged");
  });

  it("falls back safely when stored state is invalid", () => {
    window.localStorage.setItem(ASSISTIVE_UX_STORAGE_KEY, "not-json");

    expect(shouldShowAssistiveMoment(changeSoundId)).toBe(true);
  });
});
