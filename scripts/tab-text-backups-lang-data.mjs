import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LANGUAGE_IDS = Object.freeze([
    'ar',
    'bn',
    'de',
    'es',
    'fr',
    'hi',
    'id',
    'it',
    'ja',
    'ko',
    'nl',
    'pl',
    'pt',
    'pt-BR',
    'ru',
    'sv',
    'tr',
    'uk',
    'vi',
    'zh-CN'
]);

const FIELD_AND_SOURCE_BY_TEXT_ID = Object.freeze({
    tab_intro: ['description', 'backupsTabIntro'],
    inventory_title: ['label', 'backupsInventoryTitle'],
    empty: ['label', 'backupsEmpty'],
    snapshots_root: ['label', 'backupsSnapshotsRoot'],
    root_present: ['label', 'backupRootPresent'],
    root_missing: ['label', 'backupRootMissing'],
    id_column: ['label', 'backupIdColumn'],
    created_column: ['label', 'backupCreatedColumn'],
    size_column: ['label', 'backupSizeColumn'],
    reason_column: ['label', 'backupReasonColumn'],
    status_column: ['label', 'backupStatusColumn'],
    restore_column: ['label', 'backupRestoreColumn'],
    reason_update: ['label', 'backupReasonUpdate'],
    reason_scheduled: ['label', 'backupReasonScheduled'],
    health_available: ['label', 'backupHealthAvailable'],
    health_missing_records: ['label', 'backupHealthMissingRecords'],
    health_invalid_records: ['label', 'backupHealthInvalidRecords'],
    actions_disabled: ['label', 'backupsActionsDisabled'],
    restore_unavailable: ['label', 'backupRestoreUnavailable'],
    restore_backup: ['label', 'restoreBackup'],
    auto_backup_title: ['label', 'backupsAutoBackupTitle'],
    auto_backup_help: ['description', 'backupsAutoBackupHelp'],
    auto_enabled: ['label', 'backupAutoEnabled'],
    auto_interval_days: ['label', 'backupAutoIntervalDays'],
    auto_keep_latest: ['label', 'backupAutoKeepLatest'],
    restore_preview_help: ['description', 'backupsRestorePreviewHelp']
});

const RESTORE_PREVIEW_HELP_BY_LANGUAGE = Object.freeze({
    ar: 'اختر نسخة احتياطية لاستعادتها عبر إجراء التراجع المحمي.',
    bn: 'সংরক্ষিত rollback ক্রিয়ার মাধ্যমে পুনরুদ্ধার করতে একটি ব্যাকআপ বেছে নিন।',
    de: 'Wählen Sie ein Backup aus, um es über die geschützte Rollback-Aktion wiederherzustellen.',
    es: 'Elige una copia para restaurarla mediante la acción de rollback protegida.',
    fr: 'Choisissez une sauvegarde pour la restaurer via l’action de rollback protégée.',
    hi: 'सुरक्षित रोलबैक क्रिया के जरिए उसे पुनर्स्थापित करने के लिए एक बैकअप चुनें।',
    id: 'Pilih cadangan untuk memulihkannya melalui tindakan rollback yang terjaga.',
    it: "Scegli un backup da ripristinare tramite l'azione di rollback protetta.",
    ja: '保護されたロールバック操作で復元するバックアップを選択してください。',
    ko: '보호된 롤백 작업으로 복원할 백업을 선택하세요.',
    nl: 'Kies een back-up om deze via de beveiligde rollback-actie te herstellen.',
    pl: 'Wybierz kopię, aby przywrócić ją za pomocą chronionej akcji rollback.',
    pt: 'Escolha uma cópia para a restaurar através da ação protegida de rollback.',
    'pt-BR': 'Escolha um backup para restaurá-lo por meio da ação protegida de rollback.',
    ru: 'Выберите резервную копию, чтобы восстановить её через защищённое действие отката.',
    sv: 'Välj en säkerhetskopia för att återställa den via den skyddade rollback-åtgärden.',
    tr: 'Korumalı rollback eylemiyle geri yüklemek için bir yedek seçin.',
    uk: 'Виберіть резервну копію, щоб відновити її через захищену дію відкату.',
    vi: 'Chọn một bản sao lưu để khôi phục qua hành động rollback được bảo vệ.',
    'zh-CN': '选择一个备份，通过受保护的回滚操作恢复它。'
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const langPacksDir = path.join(repoRoot, 'src', 'reports', 'ui', 'lang-packs');

function readLocalUiText(langId) {
    const filePath = path.join(langPacksDir, `garda-ui-${langId}.json`);
    const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!pack?.LOCAL_UI_TEXT || typeof pack.LOCAL_UI_TEXT !== 'object') {
        throw new Error(`LOCAL_UI_TEXT is missing in ${filePath}`);
    }
    return pack.LOCAL_UI_TEXT;
}

function getTextValue(langId, localUiText, textId) {
    if (textId === 'restore_preview_help') {
        const translatedValue = RESTORE_PREVIEW_HELP_BY_LANGUAGE[langId];
        if (!translatedValue) {
            throw new Error(`Missing restore preview translation for ${langId}`);
        }
        return translatedValue;
    }

    const [, sourceKey] = FIELD_AND_SOURCE_BY_TEXT_ID[textId];
    const sourceValue = localUiText[sourceKey];
    if (typeof sourceValue !== 'string' || sourceValue.length === 0) {
        throw new Error(`Missing ${sourceKey} in garda-ui-${langId}.json`);
    }
    return sourceValue;
}

function buildLanguagePack(langId) {
    const localUiText = readLocalUiText(langId);
    const entries = Object.entries(FIELD_AND_SOURCE_BY_TEXT_ID).map(([textId, [fieldName]]) => {
        const textValue = getTextValue(langId, localUiText, textId);
        return [textId, Object.freeze({ [fieldName]: textValue })];
    });
    return Object.freeze(Object.fromEntries(entries));
}

export const BACKUPS_TAB_TEXT_BY_LANGUAGE = Object.freeze(
    Object.fromEntries(LANGUAGE_IDS.map((langId) => [langId, buildLanguagePack(langId)]))
);
