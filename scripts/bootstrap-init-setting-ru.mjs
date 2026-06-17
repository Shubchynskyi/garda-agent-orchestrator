import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const INIT_SETTING_TEXT_IDS = [
    'AssistantLanguage',
    'AssistantBrevity',
    'SourceOfTruth',
    'ActiveAgentFiles',
    'EnforceNoAutoCommit',
    'ClaudeOrchestratorFullAccess',
    'TokenEconomyEnabled',
    'ProviderMinimalism',
    'OrchestratorVersion',
    'AssistantLanguageConfirmed',
    'ActiveAgentFilesConfirmed',
    'ProjectRulesUpdated',
    'SkillsPromptCompleted',
    'OrdinaryDocPathsConfirmed',
    'VerificationPassed',
    'ManifestValidationPassed',
    'LastSeededCompileGateCommand',
    'LastSeededFullSuiteCommand',
    'reinit',
    'agent-init'
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ruPackPath = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs', 'garda-ui-ru.json');
const outputPath = path.join(repoRoot, 'src', 'reports', 'ui', 'init-setting-text', 'lang', 'ru.json');

const sourcePack = JSON.parse(fs.readFileSync(ruPackPath, 'utf8')).LOCAL_UI_INIT_SETTING_TEXT;
const filtered = {};
for (const id of INIT_SETTING_TEXT_IDS) {
    if (sourcePack[id]) {
        filtered[id] = sourcePack[id];
    }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath} (${Object.keys(filtered).length} entries)`);
