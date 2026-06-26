export const STATIC_HTML_REPORT_STYLES = `
:root { color-scheme: light; --ink: #18202a; --muted: #667085; --line: #d8dee8; --panel: #f7f9fc; --accent: #1f7a6d; --accent-2: #8a4b17; --danger: #b42318; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: #ffffff; }
header { padding: 20px 24px 12px; border-bottom: 1px solid var(--line); background: #fdfefe; }
h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
h2 { margin: 0; font-size: 20px; letter-spacing: 0; }
h3 { margin: 0 0 10px; font-size: 15px; letter-spacing: 0; }
p { margin: 0; }
code, pre { font-family: Consolas, "Courier New", monospace; }
pre { white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 260px; padding: 10px; background: #111827; color: #f9fafb; border-radius: 6px; }
button { font: inherit; }
.meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 10px 16px; }
.notice { margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); font-size: 13px; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 24px 0; border-bottom: 1px solid var(--line); background: #fff; }
.tab { border: 1px solid var(--line); border-bottom: 0; background: var(--panel); color: var(--ink); padding: 9px 12px; border-radius: 6px 6px 0 0; cursor: pointer; }
.tab[aria-selected="true"] { background: #fff; color: var(--accent); font-weight: 700; }
main { padding: 16px 24px 28px; }
.panel { display: none; }
.panel.active { display: block; }
.task-layout { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(360px, 0.8fr); gap: 16px; align-items: start; }
.table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--panel); color: #344054; position: sticky; top: 0; z-index: 1; }
th, td, td code { overflow-wrap: anywhere; }
tr[data-task-index] { cursor: pointer; }
tr[data-task-index].selected, tr[data-task-index]:focus { outline: 2px solid var(--accent); outline-offset: -2px; background: #eef8f6; }
.task-id { font-weight: 700; color: var(--accent); }
.detail, .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #fff; }
.detail-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
.eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
.pill { display: inline-flex; align-items: center; min-height: 26px; padding: 4px 8px; border-radius: 999px; background: #fff4e5; color: var(--accent-2); font-size: 12px; font-weight: 700; white-space: nowrap; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
.metric { min-height: 54px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.metric strong { font-size: 15px; overflow-wrap: anywhere; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
.stack { display: grid; gap: 14px; }
ul { margin: 0; padding-left: 18px; }
li { margin: 4px 0; }
.settings-table td:nth-child(4) { min-width: 320px; }
.value-table td:nth-child(3) { min-width: 220px; }
.instructions { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.unavailable { margin-top: 14px; color: var(--danger); }
.memory-file pre { max-height: 180px; }
@media (max-width: 980px) { .task-layout, .detail-grid { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { header, main { padding-left: 14px; padding-right: 14px; } .tabs { padding-left: 14px; padding-right: 14px; overflow-x: auto; } .metrics { grid-template-columns: 1fr; } th, td { padding: 8px; } }
`.trim();
