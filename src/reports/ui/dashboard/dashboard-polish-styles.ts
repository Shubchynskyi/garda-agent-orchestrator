/** Small dashboard chrome overrides kept separate from the generated base CSS. */
export const UI_DASHBOARD_POLISH_STYLES = [
    '.top-controls { align-items: flex-start; }',
    '.language-compact { display: grid; grid-template-columns: auto minmax(150px, 220px); align-items: end; gap: 4px 8px; }',
    '.language-icon { grid-row: 1 / span 2; padding-top: 18px; }',
    '.language-compact .visually-hidden { position: static; width: auto; height: auto; padding: 0; margin: 0; overflow: visible; clip: auto; white-space: normal; border: 0; grid-column: 2; color: var(--muted); font-size: 12px; line-height: 1.25; }',
    '.language-compact select { grid-column: 2; width: 100%; min-width: 150px; max-width: 220px; }',
    '.session-compact { flex: 1 1 100%; width: 100%; max-width: none; margin-left: 0; }',
    '.session-action-row button { flex: 1 1 138px; max-width: 190px; min-height: 34px; }',
    '.tab-buttons button { flex: 1 1 132px; max-width: 190px; min-height: 42px; white-space: normal; overflow-wrap: anywhere; line-height: 1.15; overflow: visible; }',
    '@media (max-width: 640px) { .top-controls { justify-self: stretch; width: 100%; } .language-compact { width: 100%; grid-template-columns: auto minmax(0, 1fr); } .language-compact select { max-width: none; } }'
].join('\n');
