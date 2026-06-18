import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    PROJECT_MEMORY_FILE_DEFINITIONS,
    buildProjectMemoryLiveRelativePath
} from '../../../src/core/project-memory';
import {
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_BACKUPS_TAB_TEXT,
    LOCAL_UI_INIT_SETTING_TEXT,
    LOCAL_UI_PROJECT_MEMORY_TEXT,
    LOCAL_UI_SETTING_TEXT,
    LOCAL_UI_TEXT,
    getLocalUiText,
    normalizeLocalUiLanguage
} from '../../../src/reports/ui';

function collectTypeScriptFiles(root: string): string[] {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTypeScriptFiles(fullPath));
            continue;
        }
        if (entry.isFile() && fullPath.endsWith('.ts')) {
            files.push(fullPath);
        }
    }
    return files;
}

test('imported UI language packs are registered beside built-in English', () => {
    const languageIds = LOCAL_UI_LANGUAGES.map((language) => language.id);
    assert.ok(languageIds.includes('en'));
    assert.ok(languageIds.includes('ru'));
    assert.ok(languageIds.includes('de'));
    assert.ok(languageIds.includes('uk'));
    assert.equal(getLocalUiText('de').tasksTab, 'Aufgaben');
    assert.equal(getLocalUiText('de').backupsTab, 'Backups');
});

test('Russian UI language is loaded from the language pack without source-embedded translations', () => {
    assert.equal(getLocalUiText('ru').tasksTab, 'Задачи');
    assert.equal(getLocalUiText('ru').initSettingsTab, 'Настройки инициализации');
    assert.equal(getLocalUiText('ru').taskQueueStatus, 'Статус в очереди');
    assert.equal(LOCAL_UI_SETTING_TEXT.ru['full-suite-enabled'].label, 'Обязательная полная проверка');
    assert.equal(LOCAL_UI_SETTING_TEXT.ru['compile-gate-command'].label, 'Команда compile-gate');
    assert.match(LOCAL_UI_SETTING_TEXT.ru['compile-gate-command'].description || '', /compile-gate блокируется/u);
    assert.match(LOCAL_UI_SETTING_TEXT.ru['compile-gate-command'].description || '', /не берёт fallback из 40-commands\.md/u);
    assert.match(LOCAL_UI_SETTING_TEXT.ru['compile-gate-command-fallback'].description || '', /workflow-config/u);
    assert.match(LOCAL_UI_SETTING_TEXT.ru['compile-gate-command-fallback'].description || '', /блокируется/u);
    assert.match(LOCAL_UI_BACKUPS_TAB_TEXT.ru.tab_intro.description || '', /конфигурации рабочего процесса/u);
    assert.match(LOCAL_UI_SETTING_TEXT.ru['auto-backup-enabled'].description || '', /ежедневному обслуживанию/u);
    assert.match(LOCAL_UI_SETTING_TEXT.uk['auto-backup-enabled'].description || '', /щоденн/u);
    assert.equal(LOCAL_UI_INIT_SETTING_TEXT.ru['CollectedVia'], undefined);
    assert.equal(LOCAL_UI_INIT_SETTING_TEXT.uk['CollectedVia'], undefined);
    assert.equal(LOCAL_UI_INIT_SETTING_TEXT.ru['UpdatedAt'], undefined);
    assert.match(LOCAL_UI_INIT_SETTING_TEXT.ru['EnforceNoAutoCommit'].description || '', /во всяком случае пытается/u);
    assert.match(getLocalUiText('ru').ordinaryDocsHelp, /не триггерят лишние виды ревью/u);
    assert.equal(getLocalUiText('uk').tasksTab, 'Задачі');
    assert.equal(getLocalUiText('uk').initSettingsTab, 'Параметри ініціалізації');
    assert.equal(getLocalUiText('uk').workflowTab, 'Конфігурація робочого процесу');
    assert.equal(getLocalUiText('uk').gardaSwitchState, 'Стан');
    assert.equal(getLocalUiText('uk').run, 'Запустити');
    assert.doesNotMatch(getLocalUiText('uk').guardedEditorHelp, /^Changes use/u);
    assert.doesNotMatch(getLocalUiText('uk').actionsIntro, /Task-specific commands live/u);

    const uiSourceRoot = path.join(process.cwd(), 'src', 'reports', 'ui');
    for (const sourcePath of collectTypeScriptFiles(uiSourceRoot)) {
        const source = fs.readFileSync(sourcePath, 'utf8');
        assert.doesNotMatch(source, /[А-Яа-яЁё]/u, `Cyrillic text must live in language packs only: ${sourcePath}`);
    }
});

test('unknown UI language falls back to English', () => {
    assert.equal(normalizeLocalUiLanguage('xx'), 'en');
    assert.equal(getLocalUiText('xx').tasksTab, 'Tasks');
});

test('every registered UI language pack matches the English key set', () => {
    const englishKeys = Object.keys(LOCAL_UI_TEXT.en).sort();
    for (const language of LOCAL_UI_LANGUAGES) {
        assert.deepEqual(Object.keys(LOCAL_UI_TEXT[language.id]).sort(), englishKeys);
    }
});

test('every registered UI language includes complete project-memory file descriptions', () => {
    const expectedPaths = PROJECT_MEMORY_FILE_DEFINITIONS.map((definition) => {
        return `garda-agent-orchestrator/${buildProjectMemoryLiveRelativePath(definition.fileName)}`;
    }).sort();

    for (const language of LOCAL_UI_LANGUAGES) {
        const entries = LOCAL_UI_PROJECT_MEMORY_TEXT[language.id];
        assert.ok(entries, `missing project-memory translations for ${language.id}`);
        assert.deepEqual(Object.keys(entries).sort(), expectedPaths, `project-memory path set mismatch for ${language.id}`);
        for (const memoryPath of expectedPaths) {
            assert.equal(typeof entries[memoryPath].label, 'string', `${language.id}:${memoryPath} label`);
            assert.notEqual(entries[memoryPath].label?.trim(), '', `${language.id}:${memoryPath} label`);
            assert.equal(typeof entries[memoryPath].description, 'string', `${language.id}:${memoryPath} description`);
            assert.notEqual(entries[memoryPath].description?.trim(), '', `${language.id}:${memoryPath} description`);
        }
    }
});

test('project-memory translations live in per-language packs without a sidecar file', () => {
    assert.equal(
        fs.existsSync(path.join(process.cwd(), 'src', 'reports', 'ui', 'lang-packs', 'project-memory-i18n.json')),
        false
    );
});
