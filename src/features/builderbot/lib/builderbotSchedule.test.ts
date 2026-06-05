import { describe, expect, it } from "vitest";
import {
  buildBuilderbotCronSchedule,
  parseBuilderbotCronSchedule,
} from "./builderbotSchedule";

const SUMMER_REFERENCE_DATE = new Date("2026-06-04T12:00:00Z");

describe("builderbotSchedule", () => {
  it("converts UTC Builderbot cron into local schedule controls", () => {
    expect(
      parseBuilderbotCronSchedule(
        "30 0 * * *",
        "America/Los_Angeles",
        SUMMER_REFERENCE_DATE,
      ),
    ).toMatchObject({
      preset: "daily",
      time: "17:30",
    });
  });

  it("converts local schedule controls back into UTC Builderbot cron", () => {
    expect(
      buildBuilderbotCronSchedule(
        {
          preset: "daily",
          time: "17:30",
          weekday: "1",
          customSchedule: "",
        },
        "America/Los_Angeles",
        SUMMER_REFERENCE_DATE,
      ),
    ).toBe("30 0 * * *");
  });
});
