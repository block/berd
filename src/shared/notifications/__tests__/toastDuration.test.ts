import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOAST_DURATION_SECONDS,
  MAX_TOAST_DURATION_SECONDS,
  MIN_TOAST_DURATION_SECONDS,
  NEVER_DISMISS_TOAST_DURATION_SECONDS,
  clampToastDurationSeconds,
  toastDurationSecondsToMs,
} from "../toastDuration";

describe("clampToastDurationSeconds", () => {
  it("falls back to the default for undefined input", () => {
    expect(clampToastDurationSeconds(undefined)).toBe(
      DEFAULT_TOAST_DURATION_SECONDS,
    );
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampToastDurationSeconds(Number.NaN)).toBe(
      DEFAULT_TOAST_DURATION_SECONDS,
    );
    expect(clampToastDurationSeconds(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_TOAST_DURATION_SECONDS,
    );
  });

  it("maps zero to the never-dismiss sentinel", () => {
    expect(clampToastDurationSeconds(0)).toBe(
      NEVER_DISMISS_TOAST_DURATION_SECONDS,
    );
  });

  it("recovers negative (corrupted) values to the default rather than never-dismiss", () => {
    expect(clampToastDurationSeconds(-5)).toBe(DEFAULT_TOAST_DURATION_SECONDS);
    expect(clampToastDurationSeconds(-1)).toBe(DEFAULT_TOAST_DURATION_SECONDS);
  });

  it("clamps below-minimum values up to the minimum", () => {
    expect(clampToastDurationSeconds(1)).toBe(MIN_TOAST_DURATION_SECONDS);
  });

  it("preserves the minimum boundary", () => {
    expect(clampToastDurationSeconds(MIN_TOAST_DURATION_SECONDS)).toBe(
      MIN_TOAST_DURATION_SECONDS,
    );
  });

  it("preserves the maximum boundary", () => {
    expect(clampToastDurationSeconds(MAX_TOAST_DURATION_SECONDS)).toBe(
      MAX_TOAST_DURATION_SECONDS,
    );
  });

  it("clamps above-maximum values down to the maximum", () => {
    expect(clampToastDurationSeconds(120)).toBe(MAX_TOAST_DURATION_SECONDS);
  });

  it("rounds fractional in-range values to the nearest integer", () => {
    expect(clampToastDurationSeconds(8.4)).toBe(8);
    expect(clampToastDurationSeconds(8.6)).toBe(9);
  });
});

describe("negative (corrupted) stored durations recover to the default", () => {
  it("recovers to the default duration in milliseconds rather than Infinity", () => {
    expect(toastDurationSecondsToMs(-5)).toBe(
      DEFAULT_TOAST_DURATION_SECONDS * 1000,
    );
    expect(toastDurationSecondsToMs(-5)).not.toBe(Number.POSITIVE_INFINITY);
  });
});

describe("toastDurationSecondsToMs", () => {
  it("maps the never-dismiss sentinel to Infinity", () => {
    expect(toastDurationSecondsToMs(NEVER_DISMISS_TOAST_DURATION_SECONDS)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("converts a finite duration to milliseconds", () => {
    expect(toastDurationSecondsToMs(DEFAULT_TOAST_DURATION_SECONDS)).toBe(8000);
    expect(toastDurationSecondsToMs(MIN_TOAST_DURATION_SECONDS)).toBe(3000);
    expect(toastDurationSecondsToMs(MAX_TOAST_DURATION_SECONDS)).toBe(60000);
  });

  it("re-clamps an out-of-range duration before converting", () => {
    expect(toastDurationSecondsToMs(1000)).toBe(
      MAX_TOAST_DURATION_SECONDS * 1000,
    );
  });
});
