/** Small dashboard chrome overrides kept separate from the generated base CSS. */
export const UI_DASHBOARD_POLISH_STYLES = [
    '.top-controls { align-items: flex-start; }',
    '.language-compact { display: grid; grid-template-columns: auto minmax(150px, 220px); align-items: center; gap: 4px 8px; }',
    '.language-icon { grid-column: 1; grid-row: 2; align-self: center; padding-top: 0; }',
    '.language-compact .visually-hidden { position: static; width: auto; height: auto; padding: 0; margin: 0; overflow: visible; clip: auto; white-space: normal; border: 0; grid-column: 2; color: var(--muted); font-size: 12px; line-height: 1.25; }',
    '.language-compact select { grid-column: 2; width: 100%; min-width: 150px; max-width: 220px; }',
    '.session-compact { flex: 0 1 420px; width: auto; max-width: 420px; margin-left: auto; align-items: stretch; }',
    '.session-action-row { justify-content: flex-start; }',
    '.session-action-row button { flex: 0 1 138px; max-width: 190px; min-height: 34px; }',
    '.tab-buttons button { flex: 1 1 132px; max-width: 190px; min-height: 42px; white-space: normal; overflow-wrap: anywhere; line-height: 1.15; overflow: visible; }',
    'main { background: #f3f6fa; border-top: 1px solid #e4eaf2; }',
    '.notice, .warnings, .switch-strip, #action-status { max-width: 1480px; margin-left: auto; margin-right: auto; }',
    '.tab { max-width: 1480px; margin-left: auto; margin-right: auto; box-shadow: 0 8px 24px rgba(15, 23, 42, .06); }',
    '.workflow-setting-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }',
    '.workflow-setting-tabs button { flex: 0 1 180px; min-height: 38px; }',
    '.workflow-setting-tabs button.active { color: #fff; background: var(--blue); border-color: var(--blue); }',
    '.ordinary-doc-form { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 10px; align-items: end; margin-top: 10px; }',
    '.ordinary-doc-form label { display: grid; gap: 5px; color: var(--muted); font-size: 13px; }',
    '.ordinary-doc-form input { width: 100%; }',
    '@media (max-width: 760px) { .session-compact { flex: 1 1 100%; width: 100%; max-width: none; margin-left: 0; } .ordinary-doc-form { grid-template-columns: 1fr; } }',
    '@media (max-width: 640px) { .top-controls { justify-self: stretch; width: 100%; } .language-compact { width: 100%; grid-template-columns: auto minmax(0, 1fr); } .language-compact select { max-width: none; } }'
].join('\n');
