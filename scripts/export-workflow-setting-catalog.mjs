import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflowSettingTextCatalog } from '../src/reports/ui/workflow-setting-text/catalog.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'src', 'reports', 'ui', 'workflow-setting-text', 'en-reference.json');

fs.writeFileSync(outputPath, `${JSON.stringify(buildWorkflowSettingTextCatalog(), null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
