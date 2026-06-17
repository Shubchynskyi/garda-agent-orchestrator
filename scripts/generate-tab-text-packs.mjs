import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEANUP_TAB_TEXT_BY_LANGUAGE } from './tab-text-cleanup-lang-data.mjs';
import { BACKUPS_TAB_TEXT_BY_LANGUAGE } from './tab-text-backups-lang-data.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLEANUP_KEYS_TO_REMOVE = [
    'cleanupSettingsIntro',
    'cleanupPreviewHelp',
    'cleanupEffectivePolicyTitle',
    'cleanupEffectivePolicyHelp',
    'cleanupPolicyPath',
    'cleanupDailyEnabled',
    'cleanupDailyEnabledDesc',
    'cleanupDailyDryRun',
    'cleanupDailyDryRunDesc',
    'cleanupOlderThanDays',
    'cleanupOlderThanDaysDesc',
    'cleanupKeepLatestTasks',
    'cleanupKeepLatestTasksDesc',
    'cleanupPurgeRequireConfirm',
    'cleanupPurgeRequireConfirmDesc',
    'cleanupHealthyDoneCompactDays',
    'cleanupHealthyDoneCompactDaysDesc',
    'cleanupProblemCompressDays',
    'cleanupProblemCompressDaysDesc',
    'cleanupEditSettingsTitle',
    'cleanupEditSettingsHelp',
    'cleanupMaxTasksPerRun',
    'cleanupMaxTasksPerRunDesc',
    'cleanupRunTitle',
    'cleanupRunHelp',
    'cleanupRunPreview',
    'cleanupTaskPurgeTitle',
    'cleanupTaskPurgeHelp',
    'cleanupTaskId',
    'cleanupPurgeTask',
    'cleanupValueTrue',
    'cleanupValueFalse'
];

const BACKUPS_KEYS_TO_REMOVE = [
    'backupsTabIntro',
    'backupsInventoryTitle',
    'backupsEmpty',
    'backupsSnapshotsRoot',
    'backupRootPresent',
    'backupRootMissing',
    'backupIdColumn',
    'backupCreatedColumn',
    'backupSizeColumn',
    'backupReasonColumn',
    'backupStatusColumn',
    'backupRestoreColumn',
    'backupReasonUpdate',
    'backupReasonScheduled',
    'backupHealthAvailable',
    'backupHealthMissingRecords',
    'backupHealthInvalidRecords',
    'backupsActionsDisabled',
    'backupRestoreUnavailable',
    'restoreBackup',
    'backupsAutoBackupTitle',
    'backupAutoEnabled',
    'backupAutoIntervalDays',
    'backupAutoKeepLatest',
    'backupsAutoBackupHelp',
    'backupsRestorePreviewHelp'
];

function writeLangPacks(targetDir, packsByLanguage) {
    fs.mkdirSync(path.join(targetDir, 'lang'), { recursive: true });
    for (const [languageId, pack] of Object.entries(packsByLanguage)) {
        const filePath = path.join(targetDir, 'lang', `${languageId}.json`);
        fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
        console.log(`wrote ${path.relative(repoRoot, filePath)}`);
    }
}

function stripKeysFromUiPacks(keysToRemove) {
    const packsDir = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');
    for (const fileName of fs.readdirSync(packsDir).filter((name) => name.startsWith('garda-ui-') && name.endsWith('.json'))) {
        const filePath = path.join(packsDir, fileName);
        const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const key of keysToRemove) {
            delete pack.LOCAL_UI_TEXT[key];
        }
        fs.writeFileSync(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
        console.log(`stripped ${keysToRemove.length} keys from ${fileName}`);
    }
}

writeLangPacks(path.join(repoRoot, 'src', 'reports', 'ui', 'cleanup-setting-text'), CLEANUP_TAB_TEXT_BY_LANGUAGE);
writeLangPacks(path.join(repoRoot, 'src', 'reports', 'ui', 'backups-tab-text'), BACKUPS_TAB_TEXT_BY_LANGUAGE);
stripKeysFromUiPacks(CLEANUP_KEYS_TO_REMOVE);
stripKeysFromUiPacks(BACKUPS_KEYS_TO_REMOVE);
console.log('done');
