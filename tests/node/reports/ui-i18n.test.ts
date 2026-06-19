import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_TEXT,
    assertLocalUiLanguagePacksComplete,
    getLocalUiText,
    normalizeLocalUiLanguage,
    validateLocalUiTextLanguagePack
} from '../../../src/reports/ui/ui-i18n';
import { renderLocalUiHtml } from '../../../src/reports/ui/ui-dashboard-html';

test('local UI language packs are complete and extensible by metadata', () => {
    assert.doesNotThrow(() => assertLocalUiLanguagePacksComplete());
    assert.ok(LOCAL_UI_LANGUAGES.length >= 20);
    assert.deepEqual(
        Object.keys(LOCAL_UI_TEXT.en).sort(),
        Object.keys(LOCAL_UI_TEXT.ru).sort()
    );
});

test('local UI language fallback is English at runtime', () => {
    assert.equal(normalizeLocalUiLanguage('ru'), 'ru');
    assert.equal(normalizeLocalUiLanguage('de'), 'de');
    assert.equal(normalizeLocalUiLanguage('__proto__'), 'en');
    assert.equal(normalizeLocalUiLanguage('toString'), 'en');
    assert.equal(getLocalUiText('de').tasksTab, 'Aufgaben');
});

test('local UI stale-English audit keeps machine tokens exempt', () => {
    const pack = {
        ...LOCAL_UI_TEXT.ru,
        appTitle: LOCAL_UI_TEXT.en.appTitle,
        idColumn: LOCAL_UI_TEXT.en.idColumn,
        taskActionsHelp: LOCAL_UI_TEXT.en.taskActionsHelp
    };
    const issues = validateLocalUiTextLanguagePack('ru', pack);

    assert.ok(issues.some((issue) => issue.key === 'taskActionsHelp' && issue.reason === 'local UI text still matches English source'));
    assert.equal(issues.some((issue) => issue.key === 'appTitle'), false);
    assert.equal(issues.some((issue) => issue.key === 'idColumn'), false);
});

test('local UI renders Russian chrome while preserving machine surfaces', () => {
    const html = renderLocalUiHtml(false, 'token', 'ru');

    assert.match(html, /<html lang="ru">/u);
    assert.match(html, /Загрузка сессии сервера/u);
    assert.match(html, /Русский/u);
    assert.match(html, /hasOwnProperty\.call\(languagePacks, value\)/u);
    assert.match(html, /localStorage\.setItem\('garda\.ui\.language'/u);
    assert.match(html, /garda ui/u);
    assert.doesNotMatch(html, /garda ui --target-root "\."/u);
    assert.match(html, /safe\(setting\.key\)/u);
    assert.match(html, /safe\(action\.command\)/u);
    assert.match(html, /Память проекта/u);
    assert.doesNotMatch(html, /JSON\.stringify\(audit, null, 2\)/u);
});
