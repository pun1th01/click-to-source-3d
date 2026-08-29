import React, { useEffect, useMemo, useRef, useState } from "react";
import { useOverlayStore } from "../store/overlayStore.js";
import { describeMesh } from "../meshDetails.js";
import { MeshDetails } from "./MeshDetails.js";
import {
  editSourceFile,
  SourceEditTransportError,
} from "../sourceEditClient.js";

function draftValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return "null";
  }

  return String(value);
}

function valueFromDraft(originalValue: unknown, draft: string): unknown {
  if (typeof originalValue === "number") {
    const value = Number(draft);

    if (!Number.isFinite(value)) {
      throw new Error("Enter a finite number");
    }

    return value;
  }

  if (typeof originalValue === "boolean") {
    if (draft !== "true" && draft !== "false") {
      throw new Error('Enter "true" or "false"');
    }

    return draft === "true";
  }

  if (originalValue === null && draft === "null") {
    return null;
  }

  return draft;
}

export function GenerationTrace() {
  const {
    selectedObject,
    instanceId,
    sourceRef,
    readonly,
    panelOpen,
    meshDetailsOpen,
    clearSelection,
    setMeshDetailsOpen,
    updateSourceRefArg,
  } = useOverlayStore();
  const [draftArgs, setDraftArgs] = useState<Record<string, string>>({});
  const [savingArg, setSavingArg] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const meshDetails = useMemo(
    () => describeMesh(selectedObject, instanceId),
    [selectedObject, instanceId]
  );

  useEffect(() => {
    // A new selection starts at the top. Without this the panel opens
    // mid-scroll wherever the previous object left it.
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }

    if (!sourceRef) {
      setDraftArgs({});
      return;
    }

    setDraftArgs(
      Object.fromEntries(
        Object.entries(sourceRef.args ?? {}).map(([argName, value]) => [
          argName,
          draftValue(value),
        ])
      )
    );
    setStatus(null);
    setError(null);
  }, [sourceRef]);

  if (!panelOpen || !sourceRef) {
    return null;
  }

  const handleSave = async (argName: string) => {
    const originalValue = sourceRef.args[argName];
    const draft = draftArgs[argName] ?? "";
    let newValue: unknown;

    try {
      newValue = valueFromDraft(originalValue, draft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Invalid value");
      setStatus(null);
      return;
    }

    setSavingArg(argName);
    setStatus(null);
    setError(null);

    try {
      await editSourceFile(sourceRef, argName, newValue);
      updateSourceRefArg(argName, newValue);
      setStatus(`Saved ${argName}; Vite is updating the scene.`);
    } catch (saveError) {
      const message =
        saveError instanceof SourceEditTransportError
          ? saveError.message
          : saveError instanceof Error
            ? saveError.message
            : "Unable to edit source";
      setError(message);
    } finally {
      setSavingArg(null);
    }
  };

  // TODO(follow-up): validate each arg against the source when the panel
  // opens, and render args with no resolvable literal as read-only instead of
  // as editable inputs. Today an unresolvable arg (a prop, a member
  // expression, or a mismatched identifier) looks editable and only reports
  // ARGUMENT_NOT_FOUND after Save is clicked. The `readonly` path below
  // already renders exactly the needed state. See stage5 architecture notes.
  const args = Object.entries(sourceRef.args ?? {});

  return (
    <div
      style={{
        position: "absolute",
        top: 20,
        right: 20,
        width: 300,
        // Content ranges from ~330px to ~880px depending on arg count and
        // whether the mesh disclosure is open, so the cap has to be
        // viewport-relative. 40px leaves the same 20px gap at the bottom as
        // the top offset above.
        maxHeight: "calc(100vh - 40px)",
        // max-height applies to the content box, so without this the 16px
        // padding is added on top of the cap and the card still overruns.
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "rgba(30, 30, 30, 0.9)",
        color: "#ffffff",
        padding: "16px",
        borderRadius: "8px",
        fontFamily: "monospace",
        boxShadow: "0 4px 6px rgba(0,0,0,0.3)",
        zIndex: 1000,
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "12px",
          borderBottom: "1px solid #555",
          paddingBottom: "8px",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "16px" }}>Generation Trace</h3>
        <button
          onClick={clearSelection}
          style={{
            background: "none",
            border: "none",
            color: "#aaa",
            cursor: "pointer",
            fontSize: "16px",
            padding: "0",
          }}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div
        ref={bodyRef}
        style={{
          fontSize: "13px",
          lineHeight: "1.5",
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          scrollbarWidth: "thin",
          scrollbarColor: "#555 transparent",
        }}
      >
        <div style={{ marginBottom: "8px" }}>
          <strong style={{ color: "#a8c7fa" }}>File:</strong> {sourceRef.file}
        </div>
        <div style={{ marginBottom: "8px" }}>
          <strong style={{ color: "#a8c7fa" }}>Function:</strong>{" "}
          {sourceRef.function}
        </div>
        <div style={{ marginBottom: "8px" }}>
          <strong style={{ color: "#a8c7fa" }}>Line:</strong> {sourceRef.line}
        </div>

        <div style={{ marginTop: "12px" }}>
          <strong style={{ color: "#a8c7fa" }}>Args:</strong>
          {args.length === 0 ? (
            <div style={{ marginTop: "4px" }}>No editable arguments.</div>
          ) : (
            <div style={{ display: "grid", gap: "8px", marginTop: "6px" }}>
              {args.map(([argName, originalValue]) => (
                <label
                  key={argName}
                  style={{ display: "grid", gap: "4px" }}
                >
                  <span>{argName}</span>
                  {readonly ? (
                    <div style={{ color: "#aaa", padding: "5px 0" }}>
                      {draftValue(originalValue)}
                    </div>
                  ) : (
                    <span style={{ display: "flex", gap: "6px" }}>
                      <input
                        aria-label={`Argument ${argName}`}
                        data-testid={`source-arg-${argName}`}
                        value={draftArgs[argName] ?? draftValue(originalValue)}
                        onChange={(event) =>
                          setDraftArgs((current) => ({
                            ...current,
                            [argName]: event.target.value,
                          }))
                        }
                        style={{
                          minWidth: 0,
                          flex: 1,
                          color: "#fff",
                          backgroundColor: "rgba(0,0,0,0.5)",
                          border: "1px solid #555",
                          borderRadius: "4px",
                          padding: "5px",
                          fontFamily: "monospace",
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void handleSave(argName)}
                        disabled={savingArg !== null}
                        style={{ cursor: "pointer" }}
                      >
                        {savingArg === argName ? "Saving…" : "Save"}
                      </button>
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        <MeshDetails
          details={meshDetails}
          open={meshDetailsOpen}
          onToggle={setMeshDetailsOpen}
        />
      </div>

      {/* Outside the scrolling body on purpose: feedback about a save must
          stay visible even when the body is scrolled away from the Save
          button that produced it. */}
      <div style={{ flexShrink: 0, fontSize: "13px", lineHeight: "1.5" }}>
        {status && (
          <div role="status" style={{ color: "#9fe6a0", marginTop: "10px" }}>
            {status}
          </div>
        )}
        {error && (
          <div role="alert" style={{ color: "#ff9b9b", marginTop: "10px" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
