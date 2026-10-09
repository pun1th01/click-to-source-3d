// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { draftOf, parseDraft } from "../../src/client/values.js";
import { matchesHotkey, parseHotkey } from "../../src/client/inspector.js";

describe("draftOf", () => {
  it("shows a string without quotes and anything else as written", () => {
    expect(draftOf({ raw: '"#c2643c"', value: "#c2643c", editable: true })).toBe("#c2643c");
    // Hex stays hex, a trailing zero stays: the source's own spelling.
    expect(draftOf({ raw: "0x88aa55", value: 0x88aa55, editable: true })).toBe("0x88aa55");
    expect(draftOf({ raw: "-2.20", value: -2.2, editable: true })).toBe("-2.20");
    expect(draftOf({ raw: "false", value: false, editable: true })).toBe("false");
  });
});

describe("parseDraft", () => {
  const number = { raw: "1", value: 1, editable: true };

  it("reads a number back as a number", () => {
    expect(parseDraft(number, " 2.5 ")).toEqual({ ok: true, value: 2.5 });
    expect(parseDraft(number, "0xff")).toEqual({ ok: true, value: 255 });
  });

  it("refuses what is not a number for a number", () => {
    for (const draft of ["", "abc", "Infinity", "1e400"]) {
      expect(parseDraft(number, draft).ok, draft).toBe(false);
    }
  });

  it("takes only true or false for a boolean", () => {
    const flag = { raw: "true", value: true, editable: true };
    expect(parseDraft(flag, "false")).toEqual({ ok: true, value: false });
    expect(parseDraft(flag, "no").ok).toBe(false);
  });

  it("keeps a string a string, even one that looks like a number", () => {
    expect(parseDraft({ raw: '"a"', value: "a", editable: true }, "42")).toEqual({
      ok: true,
      value: "42",
    });
  });
});

describe("the inspect hotkey", () => {
  const hotkey = parseHotkey("alt+shift+c");
  const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it("matches Alt+Shift+C by physical key", () => {
    expect(matchesHotkey(press({ altKey: true, shiftKey: true, code: "KeyC", key: "C" }), hotkey)).toBe(true);
  });

  // On macOS, Option+Shift+C types "Ç". Matching event.key would never fire.
  it("still matches when the layout turns the key into another character", () => {
    expect(matchesHotkey(press({ altKey: true, shiftKey: true, code: "KeyC", key: "Ç" }), hotkey)).toBe(true);
  });

  it("does not match with a modifier missing or added", () => {
    expect(matchesHotkey(press({ altKey: true, code: "KeyC", key: "c" }), hotkey)).toBe(false);
    expect(
      matchesHotkey(press({ altKey: true, shiftKey: true, ctrlKey: true, code: "KeyC", key: "C" }), hotkey)
    ).toBe(false);
    expect(matchesHotkey(press({ altKey: true, shiftKey: true, code: "KeyX", key: "X" }), hotkey)).toBe(false);
  });

  it("accepts other spellings of a shortcut", () => {
    const custom = parseHotkey("Ctrl + Shift + 1");
    expect(matchesHotkey(press({ ctrlKey: true, shiftKey: true, code: "Digit1", key: "!" }), custom)).toBe(true);
  });
});
