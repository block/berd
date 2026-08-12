import { describe, expect, it } from "vitest";
import {
  createTranscriptBrowserViewport,
  MAX_BLANK_VIEWPORT_RECOVERY_ATTEMPTS,
} from "./browserViewport";

function setRect(element: HTMLElement, top: number, bottom: number) {
  element.getBoundingClientRect = () =>
    ({ top, bottom, height: bottom - top }) as DOMRect;
}

describe("transcript browser viewport", () => {
  it("keeps recovery strictly bounded to two attempts per revision", () => {
    expect(MAX_BLANK_VIEWPORT_RECOVERY_ATTEMPTS).toBe(2);
  });

  it("measures real-row coverage while excluding tool-heavy spacers and offscreen measurement DOM", () => {
    const container = document.createElement("div");
    const transcript = document.createElement("div");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 6000 },
      scrollTop: { configurable: true, writable: true, value: 2400 },
    });
    setRect(container, 100, 600);

    const spacer = document.createElement("div");
    spacer.dataset.virtualFlowSpacer = "before";
    setRect(spacer, 100, 600);
    transcript.append(spacer);

    for (let index = 0; index < 24; index += 1) {
      const offscreenToolRow = document.createElement("div");
      offscreenToolRow.dataset.virtualRowOffscreenRealId = `tool-${index}`;
      setRect(offscreenToolRow, 100, 600);
      transcript.append(offscreenToolRow);
    }

    expect(
      createTranscriptBrowserViewport(
        container,
        transcript,
      ).readRealRowCoverage(),
    ).toMatchObject({
      blankViewportPixels: 500,
      intersectingRealRowCount: 0,
      realRowCount: 0,
    });

    const realRow = document.createElement("div");
    realRow.dataset.virtualRowId = "assistant-content";
    setRect(realRow, 250, 450);
    transcript.append(realRow);

    expect(
      createTranscriptBrowserViewport(
        container,
        transcript,
      ).readRealRowCoverage(),
    ).toMatchObject({
      blankViewportPixels: 108,
      intersectingRealRowCount: 1,
      realRowCount: 1,
    });
  });

  it("reads back the browser result after a scroll write", () => {
    const container = document.createElement("div");
    const transcript = document.createElement("div");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: {
        configurable: true,
        get: () => 900,
        set: () => undefined,
      },
    });
    setRect(container, 0, 400);

    expect(
      createTranscriptBrowserViewport(container, transcript).writeScrollTop(
        1200,
      ).scrollTop,
    ).toBe(900);
  });
});
