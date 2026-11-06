import type * as THREE from "three";
import type { StampedProp, StampedValue } from "@click-to-source-3d/shared";
import { editSourceAt } from "@click-to-source-3d/core/devtools";
import { h } from "./dom.js";
import { PreviewSession, type ValuePreview } from "./preview.js";
import { draftOf, parseDraft, sliderRange, sliderText, type SliderRange } from "./values.js";

/** Long enough for Vite's update to reach R3F after a save. */
const SETTLE_MS = 800;

type Draft = {
  key: string;
  file: string;
  prop: StampedProp;
  value: StampedValue;
  input: HTMLInputElement;
  slider: HTMLInputElement | null;
  range: SliderRange | null;
  initial: string;
  preview: ValuePreview | null;
};

export type EditorHost = {
  status(kind: "ok" | "error", text: string): void;
  /** The scene changed: ask for a frame. */
  redraw(): void;
  /** The set of unsaved values changed. */
  changed(): void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

const literalOf = (value: StampedValue) => `${value.line}:${value.column}`;

/**
 * The value fields in the panel: what is typed or dragged but not yet saved.
 *
 * A change is shown in the scene straight away by changing the live object, which
 * touches nothing on disk. Enter writes every changed value to source at once, and
 * Esc or leaving the object puts the scene back as it was.
 */
export class ValueEditors {
  private readonly drafts = new Map<string, Draft>();
  /** The fields now in the panel, by the literal in source each one shows. */
  private readonly fields = new Map<string, Draft[]>();
  private session: PreviewSession | null = null;
  private saving = false;

  constructor(private readonly host: EditorHost) {}

  /** Starts over for the fields of one object, undoing anything unsaved. */
  begin(object: THREE.Object3D | null): void {
    this.revert();
    this.fields.clear();
    this.session = object ? new PreviewSession(object) : null;
  }

  /** Numbers in source that would change: one for a constant however many fields show it. */
  get count(): number {
    return new Set([...this.drafts.values()].map((draft) => literalOf(draft.value))).size;
  }

  /** Whether a save is in flight, during which each write brings its own update. */
  get busy(): boolean {
    return this.saving;
  }

  editor(file: string, prop: StampedProp, value: StampedValue, index: number): HTMLElement {
    if (!value.editable) {
      return h("div", { class: "value ro" }, [h("div", { class: "readonly mono", text: value.raw })]);
    }

    const key = `${prop.element}.${prop.name}${prop.array ? `[${index}]` : ""}`;
    const input = h("input", {
      attrs: { type: "text", spellcheck: "false", "aria-label": key, "data-cts-edit": key },
    });
    const initial = draftOf(value);
    input.value = initial;

    const start = typeof value.value === "number" ? value.value : null;
    const preview = start !== null ? (this.session?.previewOf(prop, index) ?? null) : null;
    const range = preview && start !== null ? sliderRange(preview.paramName ?? prop.name, start) : null;
    const slider = range
      ? h("input", {
          class: "slider",
          title: "Drag to preview. Enter saves it to source.",
          attrs: {
            type: "range",
            min: String(range.min),
            max: String(range.max),
            step: String(range.step),
            "aria-label": `${key}, preview`,
            "data-cts-slider": key,
          },
        })
      : null;
    if (slider && start !== null) {
      slider.value = String(start);
    }

    const draft: Draft = { key, file, prop, value, input, slider, range, initial, preview };

    const literal = literalOf(value);
    this.fields.set(literal, [...(this.fields.get(literal) ?? []), draft]);

    input.addEventListener("input", () => {
      const typed = Number(input.value);
      const isNumber = input.value.trim() !== "" && Number.isFinite(typed) && start !== null;

      for (const field of this.sharing(draft)) {
        field.input.value = input.value;
        if (isNumber) {
          if (field.slider) {
            // Typing is not limited to how far a drag reaches.
            field.slider.min = String(Math.min(Number(field.slider.min), typed));
            field.slider.max = String(Math.max(Number(field.slider.max), typed));
            field.slider.value = String(typed);
          }
          field.preview?.set(typed);
        }
        this.track(field);
      }
    });

    slider?.addEventListener("input", () => {
      const next = Number(slider.value);
      for (const field of this.sharing(draft)) {
        field.input.value = sliderText(next, range!.step);
        if (field.slider) {
          field.slider.value = String(next);
        }
        field.preview?.set(next);
        this.track(field);
      }
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.saveAll();
      } else if (event.key === "Escape") {
        this.sharing(draft).forEach((field) => this.resetOne(field));
        (event.target as HTMLElement).blur();
      }
    };
    input.addEventListener("keydown", onKey);
    slider?.addEventListener("keydown", onKey);

    return h("div", { class: "value" }, [
      input,
      slider,
      value.via ? h("div", { class: "via mono", text: `${value.via} · line ${value.line}` }) : null,
    ]);
  }

  /**
   * Every field showing the same literal. `args={[SIZE, SIZE, SIZE]}` has three
   * fields and one number in source. Saving any of them changes all three, so
   * the preview has to as well, or it would show something a save will not do.
   */
  private sharing(draft: Draft): Draft[] {
    return this.fields.get(literalOf(draft.value)) ?? [draft];
  }

  private track(draft: Draft): void {
    const changed = draft.input.value !== draft.initial;
    draft.input.classList.toggle("dirty", changed);

    if (changed) {
      this.drafts.set(draft.key, draft);
    } else {
      draft.preview?.reset();
      this.drafts.delete(draft.key);
    }
    this.host.changed();
    this.host.redraw();
  }

  private resetOne(draft: Draft): void {
    draft.input.value = draft.initial;
    draft.input.classList.remove("dirty");
    if (draft.slider && typeof draft.value.value === "number") {
      draft.slider.value = String(draft.value.value);
    }
    draft.preview?.reset();
    this.drafts.delete(draft.key);
    this.host.changed();
    this.host.redraw();
  }

  /** Puts the fields and the scene back as they were. */
  revert(): void {
    const had = this.drafts.size > 0;
    for (const draft of [...this.drafts.values()]) {
      draft.input.value = draft.initial;
      draft.input.classList.remove("dirty");
      if (draft.slider && typeof draft.value.value === "number") {
        draft.slider.value = String(draft.value.value);
      }
    }
    this.drafts.clear();
    this.session?.restore();

    if (had) {
      this.host.changed();
      this.host.redraw();
    }
  }

  /**
   * Writes every changed value to source.
   *
   * Last in the file first, because rewriting a literal can change its length and
   * so move whatever follows it on the same line. Going backwards, the positions
   * still to be used are always still right. One constant shown in two fields is
   * one literal, so it is written once.
   */
  async saveAll(): Promise<void> {
    if (this.saving || this.drafts.size === 0) {
      return;
    }

    const edits = new Map<string, { draft: Draft; next: unknown }>();
    for (const draft of this.drafts.values()) {
      const parsed = parseDraft(draft.value, draft.input.value);
      if (!parsed.ok) {
        this.host.status("error", parsed.error);
        draft.input.focus();
        return;
      }
      edits.set(literalOf(draft.value), { draft, next: parsed.value });
    }

    const ordered = [...edits.values()].sort(
      (a, b) =>
        (b.draft.value.line ?? 0) - (a.draft.value.line ?? 0) ||
        (b.draft.value.column ?? 0) - (a.draft.value.column ?? 0)
    );

    this.saving = true;
    const inputs = [...this.drafts.values()].map((draft) => draft.input);
    inputs.forEach((input) => (input.disabled = true));
    let saved = 0;

    try {
      for (const { draft, next } of ordered) {
        await editSourceAt(draft.file, draft.value as never, next, draft.prop.name);
        saved++;
      }
      this.finishSave();
      const only = ordered[0].draft;
      this.host.status(
        "ok",
        `Saved ${ordered.length === 1 ? (only.value.via ?? only.prop.name) : `${ordered.length} values`}. ` +
          "Vite is updating the scene."
      );
    } catch (error) {
      if (saved > 0) {
        this.finishSave();
      }
      this.host.status(
        "error",
        saved > 0 ? `Saved ${saved} of ${ordered.length}. ${errorText(error)}` : errorText(error)
      );
    } finally {
      this.saving = false;
      inputs.forEach((input) => (input.disabled = false));
      this.host.changed();
    }
  }

  /**
   * After a save the scene already shows the new values and R3F is about to
   * apply them, so nothing is put back. The session is cleaned up a moment later,
   * once R3F has had its turn.
   */
  private finishSave(): void {
    for (const draft of this.drafts.values()) {
      draft.input.classList.remove("dirty");
    }
    this.drafts.clear();

    const finished = this.session;
    this.session = null;
    setTimeout(() => {
      finished?.settle();
      this.host.redraw();
    }, SETTLE_MS);
  }
}
