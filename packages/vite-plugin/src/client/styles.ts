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
  --point: #f5b13d;
  --agent: #b18cff;
  --pin: #6aa9ff;
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
.toggle.pointer[aria-pressed="true"] { color: var(--point); border-color: var(--point); }
.toggle .count {
  position: absolute; top: -5px; right: -5px;
  min-width: 15px; height: 15px; padding: 0 3px;
  border-radius: 8px;
  background: var(--point); color: #1c1608;
  font-size: 10px; font-weight: 600; line-height: 15px; text-align: center;
}

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
.panel[data-tab="compare"] { width: 460px; }
.head {
  display: flex; align-items: center; gap: 2px;
  padding: 6px 8px 0 8px;
  border-bottom: 1px solid var(--line);
}
.head .spacer { flex: 1; }
.tab {
  border: 0; background: none; color: var(--muted); font: inherit;
  padding: 5px 8px 7px; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  display: inline-flex; align-items: center; gap: 5px;
}
.tab:hover { color: var(--text); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.tab .count {
  min-width: 15px; padding: 0 3px; border-radius: 8px;
  background: var(--point); color: #1c1608;
  font-size: 10px; font-weight: 600; line-height: 15px; text-align: center;
}
.tab .dot, .agent-status .dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--muted);
}
.tab .dot.on, .agent-status.on .dot { background: var(--ok); }
.title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.title .kind { font-weight: 600; }
.title .name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-button {
  border: 0; background: none; color: var(--muted);
  width: 22px; height: 22px; padding: 2px; cursor: pointer; border-radius: 4px;
}
.icon-button:hover { color: var(--text); background: rgba(255, 255, 255, 0.06); }
.icon-button svg { width: 100%; height: 100%; }
.icon-button { flex-shrink: 0; }

.body { overflow-y: auto; padding: 10px 12px 12px; scrollbar-width: thin; }
.body[hidden] { display: none; }

.actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 2px; }
.action {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--line); background: rgba(255, 255, 255, 0.04);
  color: var(--text); border-radius: 6px; padding: 3px 7px; cursor: pointer; font: inherit;
}
.action:hover { border-color: var(--accent); }
.action svg { width: 12px; height: 12px; }
.action[aria-pressed="true"][data-cts-action="point"],
.action[aria-pressed="true"][data-cts-action="pointer-mode"] { border-color: var(--point); color: var(--point); }
.action[aria-pressed="true"][data-cts-action="pin"] { border-color: var(--pin); color: var(--pin); }
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
.element { color: var(--muted); margin: 8px 0 4px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.link {
  border: 0; background: none; padding: 0; margin: 0; font: inherit; font-size: 11px;
  color: var(--accent); cursor: pointer; text-align: left; overflow-wrap: anywhere;
}
.link:hover { text-decoration: underline; }
.frame { margin: 8px 0 10px; }
.frame-head, .use-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.frame-head { margin-bottom: 4px; }
.frame-head .fn, .use-head .fn { color: var(--text); font-weight: 600; }
.frame .value.ro .readonly, .use .value.ro .readonly { padding: 3px 0; }
.use { margin: 5px 0; }
.use details { margin-top: 0; }
.use summary { display: list-item; }
.use summary .use-head { display: inline-flex; vertical-align: top; }
.package { color: var(--muted); font-size: 11px; }
.numbers { margin-top: 6px; }
.number-line { margin-bottom: 8px; }
.line-text {
  color: var(--muted); font-size: 11px; margin-bottom: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.line-no { color: var(--accent); margin-right: 6px; }
.prop { display: grid; grid-template-columns: 92px 1fr; gap: 6px; align-items: start; margin-bottom: 5px; }
.prop .label { color: var(--muted); padding-top: 4px; overflow: hidden; text-overflow: ellipsis; }
.values { display: grid; grid-template-columns: repeat(auto-fit, minmax(56px, 1fr)); gap: 4px; }
.value { display: flex; flex-direction: column; min-width: 0; }
.value input {
  width: 100%;
  background: rgba(0, 0, 0, 0.35); color: var(--text);
  border: 1px solid var(--line); border-radius: 5px;
  padding: 3px 6px; font: inherit; font-family: ui-monospace, Consolas, monospace;
}
.value input:focus { outline: none; border-color: var(--accent); }
.value input.dirty { border-color: #e0b85a; }
.value input.slider {
  padding: 0; margin: 3px 0 0; height: 12px;
  border: 0; background: none; accent-color: var(--accent); cursor: ew-resize;
}
.value .via { color: var(--muted); font-size: 10.5px; margin-top: 1px; }
.readonly { color: var(--muted); padding: 3px 0; overflow-wrap: anywhere; }

.note { color: var(--muted); }
.parents { color: var(--muted); margin-top: 6px; }
details { margin-top: 12px; }
summary { cursor: pointer; color: var(--muted); }
.detail-grid { display: grid; grid-template-columns: 110px 1fr; gap: 2px 8px; margin-top: 6px; }
.detail-grid .k { color: var(--muted); }

.detail-grid .span { grid-column: 1 / -1; color: var(--muted); margin-top: 4px; }
summary .headline { color: var(--text); margin-left: 4px; }

.status { padding: 8px 12px; border-top: 1px solid var(--line); }
.status.ok { color: var(--ok); }
.status.error { color: var(--error); }
.hint { color: var(--muted); font-size: 11px; margin-top: 10px; }

.unsaved {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 12px; border-top: 1px solid var(--line);
  color: #e0b85a;
}
.unsaved[hidden] { display: none; }
.unsaved .spacer { flex: 1; }
.unsaved .primary { border-color: #e0b85a; color: #e0b85a; }

.agent-status { display: flex; align-items: center; gap: 7px; }
.connect { margin-top: 10px; }
.connect .actions { margin: 8px 0 4px; }
.action.primary { border-color: var(--accent); color: var(--accent); }
.action[disabled] { opacity: 0.6; cursor: default; }
.note.on { color: var(--ok); }
.note.bad { color: var(--error); margin-top: 6px; }
code {
  background: rgba(255, 255, 255, 0.07); border-radius: 4px; padding: 1px 4px;
  color: var(--text); overflow-wrap: anywhere;
}

.pointing { list-style: none; margin: 0 0 4px; padding: 0; counter-reset: pointed; }
.pointing li { display: flex; align-items: center; gap: 4px; counter-increment: pointed; }
.pointing li::before { content: counter(pointed); color: var(--point); width: 14px; flex-shrink: 0; }
.pointed-name {
  flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start;
  border: 0; background: none; color: var(--text); font: inherit; text-align: left;
  padding: 2px 4px; border-radius: 4px; cursor: pointer;
}
.pointed-name:hover { background: rgba(255, 255, 255, 0.06); }
.pointed-name .where { color: var(--accent); overflow-wrap: anywhere; }

.log { display: flex; flex-direction: column; gap: 1px; }
.log-row {
  display: grid; grid-template-columns: 54px 1fr; column-gap: 6px;
  width: 100%; border: 0; background: none; color: inherit; font: inherit; text-align: left;
  padding: 3px 4px; border-radius: 4px;
}
.log-row.link { cursor: pointer; }
.log-row.link:hover { background: rgba(255, 255, 255, 0.06); }
.log-time { color: var(--muted); font-size: 11px; }
.log-call { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px; min-width: 0; }
.log-tool { color: var(--agent); overflow-wrap: anywhere; }
.log-detail { color: var(--muted); overflow-wrap: anywhere; }
.log-result { grid-column: 2; color: var(--text); overflow-wrap: anywhere; }
.log-result.bad { color: var(--error); }
.pill { border-radius: 4px; padding: 0 4px; font-size: 10px; line-height: 14px; }
.pill.edit { background: rgba(224, 184, 90, 0.18); color: #e0b85a; }
.pill.point { background: rgba(177, 140, 255, 0.18); color: var(--agent); }

.compare-heads { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-left: 96px; }
.compare-head { display: flex; align-items: flex-start; gap: 2px; min-width: 0; }
.check { display: flex; align-items: center; gap: 6px; color: var(--muted); margin: 8px 0; cursor: pointer; }
.compare-grid { display: grid; grid-template-columns: 88px 1fr 1fr; gap: 2px 8px; }
.compare-grid .span { grid-column: 1 / -1; margin: 8px 0 2px; }
.compare-grid .k { color: var(--muted); overflow-wrap: anywhere; }
.compare-grid .cell { overflow-wrap: anywhere; min-width: 0; }
.compare-grid .cell.differs { color: #e0b85a; }
`;
