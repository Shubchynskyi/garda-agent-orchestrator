import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_UI_LANGUAGES, LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT } from '../../../src/reports/ui';
import {
    buildProjectMemoryStatusTextCatalog,
    listProjectMemoryStatusTextCatalogIds
} from '../../../src/reports/ui/project-memory-status-text/catalog';
import { loadProjectMemoryStatusTextTranslations } from '../../../src/reports/ui/project-memory-status-text/load-translations';
import {
    assertProjectMemoryStatusTextPackComplete,
    validateProjectMemoryStatusTextPack
} from '../../../src/reports/ui/project-memory-status-text/validate';

const PROJECT_MEMORY_STATUS_TEXT_CATALOG = buildProjectMemoryStatusTextCatalog();
const EXPECTED_STATUS_IDS = listProjectMemoryStatusTextCatalogIds(PROJECT_MEMORY_STATUS_TEXT_CATALOG);

test('project memory status text catalog covers every status row definition', () => {
    assert.equal(EXPECTED_STATUS_IDS.length, 13);
    assert.ok(EXPECTED_STATUS_IDS.includes('memory-enabled'));
    assert.ok(EXPECTED_STATUS_IDS.includes('memory-bootstrap-report'));
});

test('every non-English UI language has a complete project memory status text pack', () => {
    const loaded = loadProjectMemoryStatusTextTranslations();
    const nonEnglishLanguages = LOCAL_UI_LANGUAGES.filter((language) => language.id !== 'en');

    assert.equal(Object.keys(loaded).length, nonEnglishLanguages.length);

    for (const language of nonEnglishLanguages) {
        const pack = loaded[language.id];
        assert.ok(pack, `missing project memory status text pack for ${language.id}`);
        assertProjectMemoryStatusTextPackComplete(language.id, pack, PROJECT_MEMORY_STATUS_TEXT_CATALOG);
    }
});

test('LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT exposes English catalog and imported translations', () => {
    assert.deepEqual(Object.keys(LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT.en).sort(), EXPECTED_STATUS_IDS);
    assert.equal(LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT.ru['memory-enabled'].label, 'Обслуживание памяти включено');
    assert.equal(
        LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT.de['memory-dir'].label,
        'Memory-Verzeichnis'
    );
    assert.doesNotMatch(
        LOCAL_UI_PROJECT_MEMORY_STATUS_TEXT.uk['memory-read-strategy'].description || '',
        /How agents should read project memory/u
    );
});

test('project memory status text packs do not contain unexpected status ids', () => {
    for (const [languageId, pack] of Object.entries(loadProjectMemoryStatusTextTranslations())) {
        const issues = validateProjectMemoryStatusTextPack(languageId, pack, PROJECT_MEMORY_STATUS_TEXT_CATALOG);
        const unexpected = issues.filter((issue) => issue.reason === 'unexpected extra project memory status translation');
        assert.deepEqual(unexpected, [], `${languageId} has unexpected status ids`);
    }
});
