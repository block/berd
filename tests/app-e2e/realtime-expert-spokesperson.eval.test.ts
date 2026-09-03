import { describe, expect, it } from "vitest";

import {
  isTestDriverConnectionError,
  reconnectTestDriverUntilElement,
  type TestDriver,
} from "./lib/test-driver-client";
import { useTestDriver } from "./lib/setup";

const FIRST_QUESTION =
  "How many repositories do I have in my development folder?";
const SECOND_QUESTION = "Are any of them symbolic links?";

const COMPOSER = '[data-testid="chat-composer"]';
const HOME_COMPOSER = 'textarea[placeholder="Start a conversation"]';
const START_VOICE =
  'button[aria-label="Start voice conversation"]:not(:disabled)';
const HANG_UP = 'button[aria-label="Hang up"]';
const MUTE_MICROPHONE = 'button[aria-label="Mute microphone"]';
const UNMUTE_MICROPHONE = 'button[aria-label="Unmute microphone"]';
const STOP_GENERATION = 'button[aria-label="Stop generation"]';
const TRANSCRIPT = "[data-chat-column]";
const FINAL_SPOKESPERSON_SPEECH = [
  '[data-transcript-message-id] [data-voice-speech-status="spoken"]',
  '[data-transcript-message-id] [data-voice-speech-status="interrupted"]',
].join(",");
const ACTIVE_SPOKESPERSON_SPEECH =
  '[data-transcript-message-id] [data-voice-speech-status="speaking"]';
const TRANSCRIPT_MESSAGES = "[data-transcript-message-id]";

const POLL_INTERVAL_MS = 250;
const TURN_TIMEOUT_MS = 180_000;
const SETTLE_WINDOW_MS = 5_000;

interface SettledTurn {
  transcript: string;
  finalizedSpeechCount: number;
  expertHandoffCount: number;
  expertEndedCount: number;
}

const EXPERT_HANDOFF_LABEL = "Expert → Spokesperson";
const EXPERT_ENDED_LABEL = "Expert ended turn";
const SPOKESPERSON_SPOKEN_LABEL = "Spokesperson\nSpoken";
const SPOKESPERSON_INTERRUPTED_LABEL = "Spokesperson\nInterrupted";
const MISSING_ACTIVE_RUN_ERROR = "no active run to steer";

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function pollUntil(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

async function waitForSettledTurn(
  driver: TestDriver,
  prior: Pick<
    SettledTurn,
    "finalizedSpeechCount" | "expertHandoffCount" | "expertEndedCount"
  >,
): Promise<SettledTurn> {
  await pollUntil("terminal Expert turn visibility", async () => {
    const transcript = await driver.getText(TRANSCRIPT);
    return (
      countOccurrences(transcript, EXPERT_ENDED_LABEL) > prior.expertEndedCount
    );
  });

  await pollUntil("an Expert-informed Spokesperson reply", async () => {
    const transcript = await driver.getText(TRANSCRIPT);
    const priorEndedIndex = nthOccurrenceEndIndex(
      transcript,
      EXPERT_ENDED_LABEL,
      prior.expertEndedCount,
    );
    const handoffIndex = transcript.indexOf(
      EXPERT_HANDOFF_LABEL,
      priorEndedIndex,
    );
    const endedIndex = transcript.indexOf(EXPERT_ENDED_LABEL, priorEndedIndex);
    const coordinationIndex =
      handoffIndex >= 0 && handoffIndex < endedIndex
        ? handoffIndex
        : endedIndex;
    const afterCoordination = transcript.slice(coordinationIndex);
    return (
      afterCoordination.includes(SPOKESPERSON_SPOKEN_LABEL) ||
      afterCoordination.includes(SPOKESPERSON_INTERRUPTED_LABEL)
    );
  });

  let stableSince = Date.now();
  let priorTranscriptRows = await driver.count(TRANSCRIPT_MESSAGES);
  let priorFinalizedSpeech = await driver.count(FINAL_SPOKESPERSON_SPEECH);

  await pollUntil("the Expert and Spokesperson turn to settle", async () => {
    const [stopButtons, activeSpeech, transcriptRows, finalizedSpeech] =
      await Promise.all([
        driver.count(STOP_GENERATION),
        driver.count(ACTIVE_SPOKESPERSON_SPEECH),
        driver.count(TRANSCRIPT_MESSAGES),
        driver.count(FINAL_SPOKESPERSON_SPEECH),
      ]);
    const changed =
      transcriptRows !== priorTranscriptRows ||
      finalizedSpeech !== priorFinalizedSpeech;
    priorTranscriptRows = transcriptRows;
    priorFinalizedSpeech = finalizedSpeech;
    if (changed || stopButtons > 0 || activeSpeech > 0) {
      stableSince = Date.now();
      return false;
    }
    return Date.now() - stableSince >= SETTLE_WINDOW_MS;
  });

  const transcript = await driver.getText(TRANSCRIPT);
  return {
    transcript,
    finalizedSpeechCount: await driver.count(FINAL_SPOKESPERSON_SPEECH),
    expertHandoffCount: countOccurrences(transcript, EXPERT_HANDOFF_LABEL),
    expertEndedCount: countOccurrences(transcript, EXPERT_ENDED_LABEL),
  };
}

function nthOccurrenceEndIndex(
  text: string,
  needle: string,
  occurrenceCount: number,
): number {
  let searchFrom = 0;
  for (let index = 0; index < occurrenceCount; index += 1) {
    const found = text.indexOf(needle, searchFrom);
    if (found < 0) return searchFrom;
    searchFrom = found + needle.length;
  }
  return searchFrom;
}

function expectCompletedTurnOrdering(
  transcript: string,
  question: string,
  searchFrom = 0,
): void {
  const questionIndex = transcript.indexOf(question, searchFrom);
  const handoffIndex = transcript.indexOf(EXPERT_HANDOFF_LABEL, questionIndex);
  const endedIndex = transcript.indexOf(EXPERT_ENDED_LABEL, questionIndex);
  expect(questionIndex).toBeGreaterThanOrEqual(searchFrom);
  expect(endedIndex).toBeGreaterThan(questionIndex);
  if (handoffIndex >= 0 && handoffIndex < endedIndex) {
    expect(handoffIndex).toBeGreaterThan(questionIndex);
  }
}

function expectVisibleExpertResult(
  transcript: string,
  question: string,
  searchFrom = 0,
): void {
  const questionIndex = transcript.indexOf(question, searchFrom);
  const endedIndex = transcript.indexOf(EXPERT_ENDED_LABEL, questionIndex);
  const turnTranscript = transcript.slice(questionIndex, endedIndex);
  // The ordinary Expert result must remain in the durable Berd transcript;
  // coordination bubbles are additive and must not replace it. This scenario
  // has a numeric repository answer, while the question and acknowledgements
  // do not, making the result discriminating without requiring a specific
  // tool implementation.
  expect(turnTranscript).toMatch(/\b\d+\s+(?:Git\s+)?repositories\b/i);
}

function expectNoExpertDeliveryErrors(transcript: string): void {
  expect(transcript.toLowerCase()).not.toContain(MISSING_ACTIVE_RUN_ERROR);
}

function expectAcceptableSpeechCount(
  finalizedSpeechCount: number,
  priorSpeechCount: number,
): void {
  const utterances = finalizedSpeechCount - priorSpeechCount;
  // The Spokesperson may answer directly, or acknowledge, give one waiting
  // update, and then provide the Expert-informed answer. More than three is
  // evidence of a coordination loop.
  expect(utterances).toBeGreaterThanOrEqual(1);
  expect(utterances).toBeLessThanOrEqual(3);
}

async function sendTypedTurn(driver: TestDriver, text: string): Promise<void> {
  await driver.fill(COMPOSER, text, { timeout: 30_000 });
  await driver.keypress(COMPOSER, "Enter", { timeout: 30_000 });
  await driver.waitForText(text, { selector: TRANSCRIPT, timeout: 30_000 });
}

async function clickAcrossKnownDriverRestart(
  driver: TestDriver,
  selector: string,
  destinationSelector: string,
  timeout: number,
): Promise<void> {
  try {
    await driver.click(selector, { timeout });
  } catch (error) {
    // Navigation may tear down the old webview after it accepted the click but
    // before its driver response reaches this socket. Do not replay the click:
    // reconnect explicitly, then let the following assertion prove it landed.
    if (!isTestDriverConnectionError(error)) throw error;
  }
  await reconnectTestDriverUntilElement(driver, destinationSelector, {
    timeout,
  });
}

async function ensureMicrophoneMuted(driver: TestDriver): Promise<void> {
  await pollUntil(
    "the Realtime microphone to become muted",
    async () => {
      if ((await driver.count(UNMUTE_MICROPHONE)) > 0) return true;
      if ((await driver.count(MUTE_MICROPHONE)) === 0) return false;
      await driver.click(MUTE_MICROPHONE, { timeout: 30_000 });
      return false;
    },
    30_000,
  );
}

const liveEvalEnabled = process.env.BERD_E2E_REALTIME_EVAL === "1";

describe.skipIf(!liveEvalEnabled)(
  "Realtime Expert–Spokesperson live evaluation",
  () => {
    const driver = useTestDriver({
      reconnectAfterHomeNavigation: true,
      homeReadySelector: HOME_COMPOSER,
      captureFailureScreenshot: false,
    });

    it("answers a repository question and a causal symlink follow-up without duplicate speech", {
      timeout: 300_000,
    }, async () => {
      // useTestDriver starts each test on Home. Starting voice from that
      // composer exercises the new-chat call path and avoids carrying state
      // from whichever durable session happened to be selected beforehand.
      console.log("[realtime-eval] Home ready");
      await driver.getText(HOME_COMPOSER, { timeout: 30_000 });
      console.log("[realtime-eval] Starting voice from Home");
      await clickAcrossKnownDriverRestart(driver, START_VOICE, HANG_UP, 60_000);
      await reconnectTestDriverUntilElement(driver, COMPOSER, {
        timeout: 60_000,
      });
      await reconnectTestDriverUntilElement(driver, HANG_UP, {
        timeout: 60_000,
      });
      console.log("[realtime-eval] Durable voice session ready");
      await ensureMicrophoneMuted(driver);
      console.log("[realtime-eval] Microphone muted");

      try {
        const initialTranscript = await driver.getText(TRANSCRIPT);
        const initial = {
          transcript: initialTranscript,
          finalizedSpeechCount: await driver.count(FINAL_SPOKESPERSON_SPEECH),
          expertHandoffCount: countOccurrences(
            initialTranscript,
            EXPERT_HANDOFF_LABEL,
          ),
          expertEndedCount: countOccurrences(
            initialTranscript,
            EXPERT_ENDED_LABEL,
          ),
        };

        await sendTypedTurn(driver, FIRST_QUESTION);
        const firstTurn = await waitForSettledTurn(driver, initial);
        expectCompletedTurnOrdering(firstTurn.transcript, FIRST_QUESTION);
        expectVisibleExpertResult(firstTurn.transcript, FIRST_QUESTION);
        expectNoExpertDeliveryErrors(firstTurn.transcript);
        expectAcceptableSpeechCount(
          firstTurn.finalizedSpeechCount,
          initial.finalizedSpeechCount,
        );

        await sendTypedTurn(driver, SECOND_QUESTION);
        const secondTurn = await waitForSettledTurn(driver, firstTurn);

        const firstIndex = secondTurn.transcript.indexOf(FIRST_QUESTION);
        const secondIndex = secondTurn.transcript.indexOf(SECOND_QUESTION);
        expect(firstIndex).toBeGreaterThanOrEqual(0);
        expect(secondIndex).toBeGreaterThan(firstIndex);
        expectCompletedTurnOrdering(
          secondTurn.transcript,
          SECOND_QUESTION,
          firstIndex + FIRST_QUESTION.length,
        );
        expectVisibleExpertResult(
          secondTurn.transcript,
          SECOND_QUESTION,
          firstIndex + FIRST_QUESTION.length,
        );
        expectNoExpertDeliveryErrors(secondTurn.transcript);
        expectAcceptableSpeechCount(
          secondTurn.finalizedSpeechCount,
          firstTurn.finalizedSpeechCount,
        );
      } finally {
        if ((await driver.count(HANG_UP)) > 0) {
          await driver.click(HANG_UP);
        }
      }
    });
  },
);
