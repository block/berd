import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimSessionFeedbackSurveyCooldown } from "@/shared/api/feedbackSurvey";
import { feedbackSurveySink } from "./feedbackSurveySink";
import {
  claimSessionFeedbackSurvey,
  isSessionFeedbackSurveyActive,
  markSessionFeedbackSurveyAppeared,
  recordSessionFeedbackSurveyResponse,
  SESSION_SURVEY_MINIMUM_AGE_MS,
} from "./sessionFeedbackSurveyState";

vi.mock("@/shared/api/feedbackSurvey", () => ({
  claimSessionFeedbackSurveyCooldown: vi.fn().mockResolvedValue(true),
}));
vi.mock("./feedbackSurveySink", () => ({ feedbackSurveySink: vi.fn() }));

const claimCooldown = vi.mocked(claimSessionFeedbackSurveyCooldown);
const sendEvent = vi.mocked(feedbackSurveySink);
const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function claim(
  sessionId: string,
  overrides: Partial<Parameters<typeof claimSessionFeedbackSurvey>[0]> = {},
) {
  return claimSessionFeedbackSurvey({
    sessionId,
    messageId: "assistant-1",
    currentMessageIds: new Set(["assistant-1"]),
    sessionCreatedAt: new Date(
      NOW - SESSION_SURVEY_MINIMUM_AGE_MS,
    ).toISOString(),
    userTurnCount: 5,
    samplingRateBasisPoints: 250,
    now: NOW,
    random: 0,
    cooldownRandom: 0,
    ...overrides,
  });
}

describe("sessionFeedbackSurveyState", () => {
  beforeEach(() => {
    localStorage.clear();
    claimCooldown.mockReset().mockResolvedValue(true);
    sendEvent.mockClear();
  });

  it("fails closed until all eligibility requirements are met", async () => {
    await expect(
      claim("rate-off", { samplingRateBasisPoints: 0 }),
    ).resolves.toBeNull();
    await expect(claim("too-short", { userTurnCount: 4 })).resolves.toBeNull();
    await expect(
      claim("too-new", {
        sessionCreatedAt: new Date(
          NOW - SESSION_SURVEY_MINIMUM_AGE_MS + 1,
        ).toISOString(),
      }),
    ).resolves.toBeNull();
    expect(claimCooldown).not.toHaveBeenCalled();
  });

  it("samples each eligible completion once", async () => {
    claimCooldown.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(claim("not-selected")).resolves.toBeNull();
    await expect(claim("not-selected")).resolves.toBeNull();
    await expect(
      claim("not-selected", {
        messageId: "assistant-2",
        currentMessageIds: new Set(["assistant-2"]),
      }),
    ).resolves.toEqual(expect.objectContaining({ messageId: "assistant-2" }));
    expect(claimCooldown).toHaveBeenCalledTimes(2);
  });

  it("does not prompt the same session after an appearance", async () => {
    const survey = await claim("appeared-once");
    expect(survey).not.toBeNull();
    if (!survey) throw new Error("expected survey to be selected");
    markSessionFeedbackSurveyAppeared("appeared-once", survey.appearanceId);

    await expect(
      claim("appeared-once", {
        messageId: "assistant-2",
        currentMessageIds: new Set(["assistant-2"]),
      }),
    ).resolves.toBeNull();
    expect(claimCooldown).toHaveBeenCalledTimes(1);
  });

  it("serializes duplicate claims for one session", async () => {
    let resolveCooldown: ((selected: boolean) => void) | undefined;
    claimCooldown.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCooldown = resolve;
        }),
    );

    const first = claim("concurrent");
    const second = claim("concurrent");
    await Promise.resolve();
    expect(claimCooldown).toHaveBeenCalledTimes(1);
    resolveCooldown?.(true);

    const [firstSurvey, secondSurvey] = await Promise.all([first, second]);
    expect(firstSurvey).not.toBeNull();
    expect(secondSurvey).toEqual(firstSurvey);
    expect(claimCooldown).toHaveBeenCalledTimes(1);
  });

  it("emits one appearance and one compatible response event", async () => {
    const survey = await claim("responded");
    expect(survey).not.toBeNull();
    if (!survey) throw new Error("expected survey to be selected");
    markSessionFeedbackSurveyAppeared("responded", survey.appearanceId);
    markSessionFeedbackSurveyAppeared("responded", survey.appearanceId);
    recordSessionFeedbackSurveyResponse(
      "responded",
      survey.appearanceId,
      "fine",
    );
    recordSessionFeedbackSurveyResponse(
      "responded",
      survey.appearanceId,
      "bad",
    );

    expect(sendEvent).toHaveBeenCalledTimes(2);
    expect(sendEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        sessionId: "responded",
        surveyType: "session",
        eventType: "appeared",
        eventSequence: 1,
      }),
      expect.objectContaining({
        sessionId: "responded",
        surveyType: "session",
        eventType: "responded",
        response: "fine",
        eventSequence: 2,
      }),
    ]);
    expect(
      isSessionFeedbackSurveyActive("responded", survey.appearanceId),
    ).toBe(false);
  });
});
