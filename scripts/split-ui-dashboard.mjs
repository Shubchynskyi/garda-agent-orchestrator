import fs from 'node:fs';
import path from 'node:path';

const srcPath = process.argv[2] || 'scripts/.ui-dashboard-html.original.ts';
const src = fs.readFileSync(srcPath, 'utf8');
const scriptStart = src.indexOf('<script>\n') + '<script>\n'.length;
const scriptEnd = src.indexOf('\n</script>');
const client = src.slice(scriptStart, scriptEnd);
const styleStart = src.indexOf('<style>\n') + '<style>\n'.length;
const styleEnd = src.indexOf('\n</style>');
const styles = src.slice(styleStart, styleEnd);
const bodyStart = src.indexOf('<body>\n') + '<body>\n'.length;
const bodyEnd = src.indexOf('\n<div class="modal-backdrop"');
const markup = src.slice(bodyStart, bodyEnd);
const preludeEnd = client.indexOf('function normalizeLanguage');
const prelude = client.slice(0, preludeEnd);
const rest = client.slice(preludeEnd);
const splits = [
    ['core', 'function renderOverview'],
    ['tasks', 'function renderWorkflow'],
    ['workflow', 'function localizedValueRow'],
    ['init-settings', 'function localizedMemoryFile'],
    ['project-memory', 'function renderInstructions'],
    ['instructions', 'async function postSession'],
    ['session-actions', 'function reviewSummary'],
    ['task-detail', 'for (const tabButton'],
    ['bootstrap', 'for (const tabButton']
];
let pos = 0;
const parts = {};
for (const [name, marker] of splits) {
    const idx = rest.indexOf(marker, pos);
    if (idx < 0) {
        throw new Error(`missing marker ${marker}`);
    }
    parts[name] = rest.slice(pos, idx);
    pos = idx;
}
parts.bootstrap = rest.slice(pos);

const outDir = 'src/reports/ui/dashboard';
fs.mkdirSync(outDir, { recursive: true });

const constName = (segment) => `UI_DASHBOARD_CLIENT_${segment.toUpperCase().replace(/-/g, '_')}`;
const wrapConst = (segment, body) =>
    `/** Browser-side dashboard script fragment (${segment}). */\nexport const ${constName(segment)} = ${JSON.stringify(body)};\n`;

fs.writeFileSync(path.join(outDir, 'dashboard-styles.ts'), `/** Shared dashboard CSS. */\nexport const UI_DASHBOARD_STYLES = ${JSON.stringify(styles)};\n`);
fs.writeFileSync(path.join(outDir, 'dashboard-markup.ts'), `/** Static dashboard body markup; placeholders are filled at render time. */\nexport const UI_DASHBOARD_MARKUP = ${JSON.stringify(markup)};\n`);
// dashboard-client-prelude.ts is hand-maintained (buildDashboardClientPrelude).
for (const [name, body] of Object.entries(parts)) {
    fs.writeFileSync(path.join(outDir, `dashboard-client-${name}.ts`), wrapConst(name, body));
}

console.log('split complete:', outDir);
