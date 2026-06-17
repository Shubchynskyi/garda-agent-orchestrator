import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_UI_BACKUPS_TAB_TEXT, LOCAL_UI_LANGUAGES } from '../../../src/reports/ui';
import { buildBackupsTabTextCatalog, listBackupsTabTextCatalogIds } from '../../../src/reports/ui/backups-tab-text/catalog';
import { loadBackupsTabTextTranslations } from '../../../src/reports/ui/backups-tab-text/load-translations';
import { assertBackupsTabTextPackComplete, validateBackupsTabTextPack } from '../../../src/reports/ui/backups-tab-text/validate';

const BACKUPS_TAB_TEXT_CATALOG = buildBackupsTabTextCatalog();
const EXPECTED_ENTRY_IDS = listBackupsTabTextCatalogIds(BACKUPS_TAB_TEXT_CATALOG);

test('backups tab text catalog covers every backups tab entry definition', () => {
    assert.equal(EXPECTED_ENTRY_IDS.length, 26);
    assert.ok(EXPECTED_ENTRY_IDS.includes('inventory_title'));
    assert.ok(EXPECTED_ENTRY_IDS.includes('restore_preview_help'));
});

test('every non-English UI language has a complete backups tab text pack', () => {
    const loaded = loadBackupsTabTextTranslations();
    const nonEnglishLanguages = LOCAL_UI_LANGUAGES.filter((language) => language.id !== 'en');

    assert.equal(Object.keys(loaded).length, nonEnglishLanguages.length);

    for (const language of nonEnglishLanguages) {
        const pack = loaded[language.id];
        assert.ok(pack, `missing backups tab text pack for ${language.id}`);
        assertBackupsTabTextPackComplete(language.id, pack, BACKUPS_TAB_TEXT_CATALOG);
    }
});

test('LOCAL_UI_BACKUPS_TAB_TEXT exposes English catalog and imported translations', () => {
    assert.deepEqual(Object.keys(LOCAL_UI_BACKUPS_TAB_TEXT.en).sort(), EXPECTED_ENTRY_IDS);
    assert.equal(LOCAL_UI_BACKUPS_TAB_TEXT.ru.inventory_title.label, 'Список резервных копий');
    assert.doesNotMatch(
        LOCAL_UI_BACKUPS_TAB_TEXT.de.restore_preview_help.description || '',
        /Choose a backup to restore/u
    );
});

test('backups tab text packs do not contain unexpected entry ids', () => {
    for (const [languageId, pack] of Object.entries(loadBackupsTabTextTranslations())) {
        const issues = validateBackupsTabTextPack(languageId, pack, BACKUPS_TAB_TEXT_CATALOG);
        const unexpected = issues.filter((issue) => issue.reason === 'unexpected extra backups tab translation');
        assert.deepEqual(unexpected, [], `${languageId} has unexpected entry ids`);
    }
});
