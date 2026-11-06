import { describe, expect, it } from "vitest";
import { validateLocalScheduleCron } from "./localScheduleCron";

describe("validateLocalScheduleCron", () => {
  it.each([
    "0 9 * * 1-5",
    "*/15 * * * *",
    "0,30 */5 8-17 * * 0,7",
    "*/10 * * * *",
    "0 0 0 28 * *",
    "0 0 0 */1 * *",
    "*/10 * * * * *",
    "0 0 9 * * MON",
    "  0   9 * * 1-5  ",
  ])("accepts supported cron expression %s", (cron) => {
    expect(validateLocalScheduleCron(cron)).toBeNull();
  });

  it.each([
    "",
    "@daily",
    "0 0 9 * * * 2028",
    "60 * * * *",
    "0 24 * * *",
    "0 0 0 32 * *",
    "0 0 0 1 FEB *",
    "0 0 0 * 13 *",
    "0 0 0 * * 8",
    "0 0 0 * * 5-2",
    "0 0 9 1 */1 MON",
    "0 0 0 * * */0",
    "0 0 0 * * 1,,2",
    "0 0 0 * * 1/999",
    "0 0 0 L * *",
    "*,15 9 * * *",
    "*/5,15 9 * * *",
    "0 0 0 1 * MON",
    "0 0 0 * * 1#2",
    "0 9 * * 1-5\uFEFF",
  ])("rejects expressions outside the safe subset: %s", (cron) => {
    expect(validateLocalScheduleCron(cron)).not.toBeNull();
  });
});
