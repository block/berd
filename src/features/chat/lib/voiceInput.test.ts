import { describe, expect, it } from "vitest";
import {
  getAutoSubmitMatch,
  parseAutoSubmitPhrases,
  replaceTrailingTranscribedText,
} from "./voiceInput";

describe("voiceInput helpers", () => {
  it("parses comma-separated auto-submit phrases", () => {
    expect(parseAutoSubmitPhrases(" submit, Ship It ,submit ,, ")).toEqual([
      "submit",
      "ship it",
    ]);
  });

  it("replaces only the trailing dictated segment", () => {
    expect(
      replaceTrailingTranscribedText(
        "draft dictated text",
        "dictated text",
        "dictated text submit",
      ),
    ).toBe("draft dictated text submit");
  });

  it("matches auto-submit phrases only at the end of dictated text", () => {
    expect(getAutoSubmitMatch("please submit now", ["submit"])).toBeNull();
    expect(getAutoSubmitMatch("please SUBMIT.", ["submit"])).toEqual({
      matchedPhrase: "submit",
      textWithoutPhrase: "please",
    });
  });

  it("strips the full raw phrase span when internal whitespace is repeated", () => {
    // The phrase "ship it" is matched against the *normalized* text, where
    // "ship   it" collapses to "ship it" (7 chars). But in the raw text the
    // phrase occupies 9 chars — slicing by -phrase.length would leave a
    // dangling "sh" on the end. The fix walks the raw text with a regex so
    // the slice index reflects the actual phrase span in the raw string.
    expect(getAutoSubmitMatch("hello ship   it", ["ship it"])).toEqual({
      matchedPhrase: "ship it",
      textWithoutPhrase: "hello",
    });
  });
});
