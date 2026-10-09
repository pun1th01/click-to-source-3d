/**
 * The inspector's styles, scoped by its shadow root: an application's CSS
 * cannot reach in, and nothing here can leak out.
 */
export const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }

.root {
  --bg: rgba(22, 23, 28, 0.97);
  --line: rgba(255, 255, 255, 0.09);
  --text: #e6e8eb;
  --muted: #9aa0a6;
  --accent: #3cc2b8;
  --error: #ff8a80;
  --ok: #7ee2a8;
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

.toggle {
  position: fixed;
  width: 34px; height: 34px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--muted);
  display: grid; place-items: center;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  opacity: 0.75;
  transition: opacity 120ms, color 120ms, border-color 120ms;
  padding: 0;
}
.toggle:hover { opacity: 1; color: var(--text); }
.toggle[aria-pressed="true"] { opacity: 1; color: var(--accent); border-color: var(--accent); }
.toggle svg { width: 18px; height: 18px; }

.tip {
  position: fixed;
  pointer-events: none;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 7px;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.tip .where { color: var(--accent); }
.tip .none { color: var(--muted); }

.panel {
  position: fixed;
  top: 14px; right: 14px;
  width: 330px;
  max-height: calc(100vh - 28px);
  display: flex; flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
.head .kind { font-weight: 600; }
.head .name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head .spacer { flex: 1; }
.icon-button {
  border: 0; background: none; color: var(--muted);
  width: 22px; height: 22px; padding: 2px; cursor: pointer; border-radius: 4px;
}
.icon-button:hover { color: var(--text); background: rgba(255, 255, 255, 0.06); }
.icon-button svg { width: 100%; height: 100%; }

.body { overflow-y: auto; padding: 10px 12px 12px; scrollbar-width: thin; }
.where-row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px; }
.where-row .fn { font-weight: 600; }
.where-row .file { color: var(--accent); word-break: break-all; }
.open {
  margin-left: auto; flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--line); background: rgba(255, 255, 255, 0.04);
  color: var(--text); border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit;
}
.open:hover { border-color: var(--accent); }
.open svg { width: 12px; height: 12px; }

.section { margin-top: 12px; }
.section-title {
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em;
  font-size: 10.5px; margin-bottom: 6px;
}
.element { color: var(--muted); margin: 8px 0 4px; }
.prop { display: grid; grid-template-columns: 92px 1fr; gap: 6px; align-items: start; margin-bottom: 5px; }
.prop .label { color: var(--muted); padding-top: 4px; overflow: hidden; text-overflow: ellipsis; }
.values { display: flex; flex-wrap: wrap; gap: 4px; }
.value { display: flex; flex-direction: column; min-width: 0; flex: 1 1 60px; }
.value input {
  width: 100%;
  background: rgba(0, 0, 0, 0.35); color: var(--text);
  border: 1px solid var(--line); border-radius: 5px;
  padding: 3px 6px; font: inherit; font-family: ui-monospace, Consolas, monospace;
}
.value input:focus { outline: none; border-color: var(--accent); }
.value input.dirty { border-color: #e0b85a; }
.value .via { color: var(--muted); font-size: 10.5px; margin-top: 1px; }
.value.ro { flex: 2 1 auto; }
.readonly { color: var(--muted); padding: 3px 0; overflow-wrap: anywhere; }

.note { color: var(--muted); }
.parents { color: var(--muted); margin-top: 6px; }
details { margin-top: 12px; }
summary { cursor: pointer; color: var(--muted); }
.detail-grid { display: grid; grid-template-columns: 110px 1fr; gap: 2px 8px; margin-top: 6px; }
.detail-grid .k { color: var(--muted); }

.status { padding: 8px 12px; border-top: 1px solid var(--line); }
.status.ok { color: var(--ok); }
.status.error { color: var(--error); }
.hint { color: var(--muted); font-size: 11px; margin-top: 10px; }
`;
