// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { draftOf, parseDraft, sliderRange, sliderText } from "../../src/client/values.js";
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

describe("parseDraft for colours", () => {
  const hex = { raw: "0x88aa55", value: 0x88aa55, editable: true };
  const css = { raw: '"#88aa55"', value: "#88aa55", editable: true };

  it("takes a colour typed with # for one written as a number", () => {
    expect(parseDraft(hex, "#ff0000")).toEqual({ ok: true, value: 0xff0000 });
    expect(parseDraft(hex, "#f00")).toEqual({ ok: true, value: 0xff0000 });
  });

  it("takes one typed as a number for one written as a string", () => {
    expect(parseDraft(css, "0xff0000")).toEqual({ ok: true, value: "#ff0000" });
    expect(parseDraft(css, "0x0000ff")).toEqual({ ok: true, value: "#0000ff" });
  });

  it("leaves numbers that aren't colours as numbers", () => {
    expect(parseDraft({ raw: "16", value: 16, editable: true }, "#ff0000")).toMatchObject({ ok: false });
    expect(parseDraft({ raw: '"hello"', value: "hello", editable: true }, "0xff0000")).toEqual({ ok: true, value: "0xff0000" });
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

describe("sliderRange", () => {
  it("runs from nothing to one for what only means that", () => {
    expect(sliderRange("roughness", 0.4)).toEqual({ min: 0, max: 1, step: 0.01 });
    expect(sliderRange("material-opacity", 1)).toEqual({ min: 0, max: 1, step: 0.01 });
  });

  it("makes whole steps for segments, and never goes below one", () => {
    expect(sliderRange("widthSegments", 32)).toEqual({ min: 1, max: 64, step: 1 });
    expect(sliderRange("radialSegments", 100)).toEqual({ min: 1, max: 200, step: 1 });
  });

  it("gives a rotation a full turn either way", () => {
    expect(sliderRange("rotation", 0)).toMatchObject({ min: -Math.PI, max: Math.PI });
    expect(sliderRange("rotation-y", 5)).toMatchObject({ min: -Math.PI, max: 5 });
  });

  it("does not take a size below zero", () => {
    expect(sliderRange("radius", 2)).toMatchObject({ min: 0, max: 6 });
    expect(sliderRange("intensity", 0)).toMatchObject({ min: 0, max: 1 });
    expect(sliderRange("height", 1.4)).toMatchObject({ min: 0 });
  });

  it("reaches either way from anything else", () => {
    expect(sliderRange("position", 6)).toMatchObject({ min: 0, max: 12 });
    expect(sliderRange("position", -2.2)).toMatchObject({ min: -4.4, max: 0 });
    expect(sliderRange("position", 0)).toMatchObject({ min: -2, max: 2 });
  });

  // A negative "size" is a deliberate value, not one to be clamped away.
  it("always keeps the value itself in range", () => {
    for (const [name, value] of [["scale", -2], ["roughness", 3], ["rotation", 10], ["width", 100000], ["x", 1e-6]] as const) {
      const range = sliderRange(name, value);
      expect(range.min).toBeLessThanOrEqual(value);
      expect(range.max).toBeGreaterThanOrEqual(value);
    }
  });

  it("takes a step in proportion to the range", () => {
    expect(sliderRange("position", 0).step).toBe(0.01);
    expect(sliderRange("width", 1000).step).toBe(10);
  });
});

describe("sliderText", () => {
  it("writes a number worth reading, not floating-point noise", () => {
    expect(sliderText(1.2000000000000002, 0.01)).toBe("1.2");
    expect(sliderText(3.14159, 0.01)).toBe("3.14");
    expect(sliderText(32, 1)).toBe("32");
    expect(sliderText(1200, 10)).toBe("1200");
  });
});
