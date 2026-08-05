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
    LOCAL_UI_ACTION_TEXT,
    LOCAL_UI_INIT_SETTING_TEXT,
    LOCAL_UI_PROJECT_MEMORY_TEXT,
    LOCAL_UI_SETTING_TEXT,
    LOCAL_UI_TEXT,
    getLocalUiText,
    normalizeLocalUiLanguage
} from '../../../src/reports/ui';
import { createLocalUiTranslationLoader } from '../../../src/reports/ui/ui-i18n-loader-factory';

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
    assert.equal(getLocalUiText('de').backupsTab, 'Sicherungen');
});

test('UI translation loader factory freezes and reuses imported pack maps', () => {
    const germanPack = { greeting: { label: 'Hallo' } };
    const loadTranslations = createLocalUiTranslationLoader({ de: germanPack });
    const translations = loadTranslations();

    assert.strictEqual(loadTranslations(), translations);
    assert.strictEqual(translations.de, germanPack);
    assert.equal(Object.isFrozen(translations), true);
    assert.equal(Object.isFrozen(germanPack), true);
    assert.equal(translations.de.greeting.label, 'Hallo');
});

test('Russian UI language is loaded from the language pack without source-embedded translations', () => {
    assert.equal(getLocalUiText('ru').tasksTab, 'Задачи');
    assert.equal(getLocalUiText('ru').initSettingsTab, 'Настройки инициализации');
    assert.equal(getLocalUiText('ru').taskQueueStatus, 'Статус в очереди');
    assert.equal(LOCAL_UI_SETTING_TEXT.ru['full-suite-enabled'].label, 'Обязательная полная проверка');
    assert.equal(LOCAL_UI_SETTING_TEXT.ru['full-suite-timeout-blocker'].label, 'Блокер таймаута полной проверки');
    assert.equal(LOCAL_UI_SETTING_TEXT.ru['full-suite-timeout-retry-count'].label, 'Повторы таймаута полной проверки');
    assert.equal(LOCAL_UI_SETTING_TEXT.ru['compile-gate-command'].label, 'Команда гейта компиляции');
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
    assert.equal(getLocalUiText('ru').profileFindingDispositionTitle, 'Обработка находок ревью');
    assert.match(getLocalUiText('ru').profileFindingDispositionHelp, /только для будущих задач/u);
    assert.equal(getLocalUiText('ru').profileFindingPolicyPreset, 'Предустановка политики');
    assert.equal(getLocalUiText('ru').profileFindingResidualRisk, 'Остаточный риск');
    assert.equal(getLocalUiText('ru').profileFindingActionFixNow, 'Исправить сейчас');
    assert.equal(getLocalUiText('ru').profileFindingActionCreateFollowUp, 'Создать отдельную задачу');
    assert.equal(getLocalUiText('ru').profileFindingActionIgnore, 'Принять без отдельной задачи');
    assert.equal(getLocalUiText('ru').profileFindingPresetCustom, 'Пользовательский');
    assert.equal(getLocalUiText('ru').qualityGateEffectSkippedCadence, 'Пропущено — пока не требуется');
    assert.equal(getLocalUiText('ru').fullSuiteTimeoutBlocker, 'Таймаут блокирует задачу');
    assert.equal(getLocalUiText('ru').fullSuiteForecastExclusionReasons, 'Причины исключения из прогноза');
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

test('finding policy translations never expose canonical enum ids as user-facing labels', () => {
    const labelKeys = [
        'profileFindingActionFixNow',
        'profileFindingActionCreateFollowUp',
        'profileFindingActionIgnore',
        'profileFindingPresetSoft',
        'profileFindingPresetBalanced',
        'profileFindingPresetStrict',
        'profileFindingPresetCustom'
    ] as const;
    for (const language of LOCAL_UI_LANGUAGES) {
        const text = LOCAL_UI_TEXT[language.id];
        for (const key of labelKeys) {
            assert.notEqual(text[key].trim(), '', `${language.id}:${key}`);
            assert.doesNotMatch(text[key], /_/u, `${language.id}:${key} must be a user-facing label`);
        }
        assert.doesNotMatch(text.profileFindingDispositionHelp, /\b(?:fix_now|create_follow_up)\b/u, `${language.id}:profileFindingDispositionHelp`);
        if (language.id !== 'en') {
            assert.doesNotMatch(text.profileFindingDispositionHelp, /\bCritical\b/u, `${language.id}:profileFindingDispositionHelp`);
        }
        assert.notEqual(text.profileFindingActionIgnoreHelp.trim(), '', `${language.id}:profileFindingActionIgnoreHelp`);
        assert.notEqual(text.qualityGateEffectSkippedCadence.trim(), '', `${language.id}:qualityGateEffectSkippedCadence`);
    }
});

test('protected manifest repair action uses short labels in every UI language', () => {
    assert.equal(LOCAL_UI_ACTION_TEXT.en['repair-protected-manifest'].label, 'Update manifest');
    assert.equal(LOCAL_UI_ACTION_TEXT.ru['repair-protected-manifest'].label, 'Обновить манифест');
    for (const language of LOCAL_UI_LANGUAGES) {
        const label = LOCAL_UI_ACTION_TEXT[language.id]?.['repair-protected-manifest']?.label || '';
        assert.notEqual(label.trim(), '', `${language.id} protected manifest repair label`);
        assert.ok(label.length <= 24, `${language.id} protected manifest repair label should stay compact`);
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
