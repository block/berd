import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimSessionFeedbackSurveyCooldown } from "@/shared/api/feedbackSurvey";
import { feedbackSurveySink } from "./feedbackSurveySink";
import {
  claimSessionFeedbackSurvey,
  isSessionFeedbackSurveyPresentable,
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

  it("applies the basis-point hazard once per eligible completion", async () => {
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

  it("keeps an appeared survey presentable across virtualized remounts", async () => {
    const survey = await claim("appeared-once");
    expect(survey).not.toBeNull();
    if (!survey) throw new Error("expected survey to be selected");
    markSessionFeedbackSurveyAppeared("appeared-once", survey.appearanceId);

    expect(
      isSessionFeedbackSurveyPresentable("appeared-once", survey.appearanceId),
    ).toBe(true);
    recordSessionFeedbackSurveyResponse(
      "appeared-once",
      survey.appearanceId,
      "good",
    );
    expect(sendEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: "responded", response: "good" }),
    );

    await expect(
      claim("appeared-once", {
        messageId: "assistant-2",
        currentMessageIds: new Set(["assistant-2"]),
      }),
    ).resolves.toBeNull();
    expect(claimCooldown).toHaveBeenCalledTimes(1);
  });

  it("preserves another renderer's winner when a losing claim settles later", async () => {
    let resolveCooldown: ((selected: boolean) => void) | undefined;
    claimCooldown.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCooldown = resolve;
        }),
    );

    const losingClaim = claim("cross-renderer");
    await vi.waitFor(() => expect(claimCooldown).toHaveBeenCalledTimes(1));

    const winner = {
      appearanceId: "winning-appearance",
      messageId: "assistant-from-winning-renderer",
    };
    localStorage.setItem(
      "berd:session-feedback-survey:v1:cross-renderer",
      JSON.stringify({
        version: 1,
        lastEvaluatedMessageId: winner.messageId,
        active: winner,
        appeared: false,
        response: null,
      }),
    );
    resolveCooldown?.(false);

    await expect(losingClaim).resolves.toEqual(winner);
    expect(
      JSON.parse(
        localStorage.getItem(
          "berd:session-feedback-survey:v1:cross-renderer",
        ) ?? "null",
      ),
    ).toMatchObject({ active: winner });
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
      }),
      expect.objectContaining({
        sessionId: "responded",
        surveyType: "session",
        eventType: "responded",
        response: "fine",
      }),
    ]);
    expect(
      isSessionFeedbackSurveyPresentable("responded", survey.appearanceId),
    ).toBe(false);
  });
});
