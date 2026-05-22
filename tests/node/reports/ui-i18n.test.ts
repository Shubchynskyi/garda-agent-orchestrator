import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_TEXT,
    assertLocalUiLanguagePacksComplete,
    getLocalUiText,
    normalizeLocalUiLanguage
} from '../../../src/reports/ui-i18n';
import { renderLocalUiHtml } from '../../../src/reports/ui-dashboard-html';

test('local UI language packs are complete and extensible by metadata', () => {
    assert.doesNotThrow(() => assertLocalUiLanguagePacksComplete());
    assert.deepEqual(LOCAL_UI_LANGUAGES.map((language) => language.id), ['en', 'ru']);
    assert.deepEqual(
        Object.keys(LOCAL_UI_TEXT.en).sort(),
        Object.keys(LOCAL_UI_TEXT.ru).sort()
    );
});

test('local UI language fallback is English at runtime', () => {
    assert.equal(normalizeLocalUiLanguage('ru'), 'ru');
    assert.equal(normalizeLocalUiLanguage('de'), 'en');
    assert.equal(normalizeLocalUiLanguage('__proto__'), 'en');
    assert.equal(normalizeLocalUiLanguage('toString'), 'en');
    assert.equal(getLocalUiText('de').tasksTab, 'Tasks');
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
