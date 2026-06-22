import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_UI_CLEANUP_SETTING_TEXT, LOCAL_UI_LANGUAGES } from '../../../src/reports/ui';
import { buildCleanupSettingTextCatalog, listCleanupSettingTextCatalogIds } from '../../../src/reports/ui/cleanup-setting-text/catalog';
import { loadCleanupSettingTextTranslations } from '../../../src/reports/ui/cleanup-setting-text/load-translations';
import { assertCleanupSettingTextPackComplete, validateCleanupSettingTextPack } from '../../../src/reports/ui/cleanup-setting-text/validate';

const CLEANUP_SETTING_TEXT_CATALOG = buildCleanupSettingTextCatalog();
const EXPECTED_SETTING_IDS = listCleanupSettingTextCatalogIds(CLEANUP_SETTING_TEXT_CATALOG);

test('cleanup setting text catalog covers every cleanup setting definition', () => {
    assert.equal(EXPECTED_SETTING_IDS.length, 25);
    assert.ok(EXPECTED_SETTING_IDS.includes('daily_maintenance_enabled'));
    assert.ok(EXPECTED_SETTING_IDS.includes('manual_runtime_cleanup'));
});

test('every non-English UI language has a complete cleanup setting text pack', () => {
    const loaded = loadCleanupSettingTextTranslations();
    const nonEnglishLanguages = LOCAL_UI_LANGUAGES.filter((language) => language.id !== 'en');

    assert.equal(Object.keys(loaded).length, nonEnglishLanguages.length);

    for (const language of nonEnglishLanguages) {
        const pack = loaded[language.id];
        assert.ok(pack, `missing cleanup setting text pack for ${language.id}`);
        assertCleanupSettingTextPackComplete(language.id, pack, CLEANUP_SETTING_TEXT_CATALOG);
    }
});

test('LOCAL_UI_CLEANUP_SETTING_TEXT exposes English catalog and imported translations', () => {
    assert.deepEqual(Object.keys(LOCAL_UI_CLEANUP_SETTING_TEXT.en).sort(), EXPECTED_SETTING_IDS);
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.purge_require_confirm.label,
        'Automatic cleanup confirmation safeguard'
    );
    assert.match(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.purge_require_confirm.description || '',
        /Manual UI cleanup and task-artifact cleanup always require their own typed confirmation phrases/u
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.healthy_done_compact_after_days.label,
        'Compress healthy DONE after (days)'
    );
    assert.match(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.manual_runtime_cleanup.description || '',
        /Preview is a dry-run report.*Run cleanup removes/u
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.task_purge.label,
        'Task runtime artifact cleanup'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.purge_task_button.label,
        'Clean task runtime artifacts'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.run_preview.label,
        'Preview: do not delete'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.run_apply.label,
        'Run cleanup'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.cleanup_report.label,
        'Cleanup report'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.report_would_remove.label,
        'Would remove'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.en.report_removed.label,
        'Removed'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.daily_maintenance_enabled.label,
        'Ежедневное обслуживание'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.healthy_done_compact_after_days.label,
        'Сжимать здоровые DONE после (дней)'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.task_purge.label,
        'Очистка runtime-артефактов задачи'
    );
    assert.match(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.manual_runtime_cleanup.description || '',
        /Запустить очистку удаляет/u
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.run_preview.label,
        'Предпросмотр: ничего не удалять'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.run_apply.label,
        'Запустить очистку'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.cleanup_report.label,
        'Отчёт очистки'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.report_would_remove.label,
        'Будет удалено'
    );
    assert.equal(
        LOCAL_UI_CLEANUP_SETTING_TEXT.ru.report_removed.label,
        'Удалено'
    );
    assert.doesNotMatch(
        [
            LOCAL_UI_CLEANUP_SETTING_TEXT.ru.purge_require_confirm.label,
            LOCAL_UI_CLEANUP_SETTING_TEXT.ru.purge_require_confirm.description,
            LOCAL_UI_CLEANUP_SETTING_TEXT.ru.task_purge.label,
            LOCAL_UI_CLEANUP_SETTING_TEXT.ru.purge_task_button.label,
            LOCAL_UI_CLEANUP_SETTING_TEXT.ru.healthy_done_compact_after_days.label
        ].join('\n'),
        /Purge задачи|Компактировать/u
    );
    assert.doesNotMatch(
        LOCAL_UI_CLEANUP_SETTING_TEXT.de.eligible_older_than_days.description || '',
        /A task must be at least this many days old/u
    );
});

test('manual cleanup descriptions name the localized run cleanup action', () => {
    for (const language of LOCAL_UI_LANGUAGES) {
        const pack = LOCAL_UI_CLEANUP_SETTING_TEXT[language.id];
        assert.ok(pack, `missing cleanup setting text for ${language.id}`);
        const runLabel = pack.run_apply.label || '';
        const description = pack.manual_runtime_cleanup.description || '';
        assert.ok(runLabel.trim(), `missing run cleanup label for ${language.id}`);
        assert.match(
            description,
            new RegExp(runLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
            `manual cleanup description should mention localized run action for ${language.id}`
        );
    }
});

test('cleanup setting text packs do not contain unexpected setting ids', () => {
    for (const [languageId, pack] of Object.entries(loadCleanupSettingTextTranslations())) {
        const issues = validateCleanupSettingTextPack(languageId, pack, CLEANUP_SETTING_TEXT_CATALOG);
        const unexpected = issues.filter((issue) => issue.reason === 'unexpected extra cleanup setting translation');
        assert.deepEqual(unexpected, [], `${languageId} has unexpected setting ids`);
    }
});
