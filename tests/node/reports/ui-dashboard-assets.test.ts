import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../src/core/constants';
import { UI_DASHBOARD_CLIENT_CORE } from '../../../src/reports/ui/dashboard/dashboard-client-core';
import { UI_DASHBOARD_CLIENT_WORKFLOW } from '../../../src/reports/ui/dashboard/dashboard-client-workflow';
import { renderLocalUiHtml } from '../../../src/reports/ui/ui-dashboard-html';
import {
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_SETTING_TEXT,
    LOCAL_UI_TEXT
} from '../../../src/reports/ui/ui-i18n';

const DASHBOARD_ASSET_DIR = join(process.cwd(), 'src/reports/ui/dashboard');

test('local UI dashboard renders packaged style and client assets', () => {
    const html = renderLocalUiHtml(true, 'asset-token', 'en');

    assert.match(html, /<style>\s*:root \{ color-scheme: light;/u);
    assert.match(html, /<script>[\s\S]*const actionToken = "asset-token";/u);
    assert.match(html, /data-tab="workflow-tab"/u);
    assert.match(html, /function renderTasks\(report\)/u);
    assert.match(html, /function renderWorkflow\(report\)/u);
    assert.match(html, /function renderTaskDetail\(detail\)/u);
});

test('dashboard asset modules are readable template literals, not escaped string blobs', () => {
    const assetSources = readdirSync(DASHBOARD_ASSET_DIR)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => readFileSync(join(DASHBOARD_ASSET_DIR, name), 'utf8'));

    assert.ok(assetSources.some((source) => source.includes('export const UI_DASHBOARD_STYLES = `')));
    assert.ok(assetSources.some((source) => source.includes('export const UI_DASHBOARD_CLIENT_WORKFLOW = `')));
    for (const source of assetSources) {
        assert.doesNotMatch(source, /export const [A-Z0-9_]+ = "(?:\\\\n|[^"]){200,}";/u);
    }
});

test('workflow settings editor renders unconfigured compile-gate through localized fallback text', () => {
    const settingsEditorNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        settingsEditorNode,
        workflowNode: { innerHTML: '', hidden: false },
        workflowPanelTitleNode: { textContent: '' },
        settingStatusNode: { innerHTML: '' },
        currentSettingsPayload: null,
        currentSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderSettingsEditor({
  enabled: true,
  settings: [{
    id: 'compile-gate-command',
    key: 'compile_gate.command',
    label: 'Compile-gate command',
    description: 'Executable compile/build/type-check command used by compile-gate.',
    current_value: '${UNCONFIGURED_COMPILE_GATE_COMMAND}',
    value_type: 'string',
    options: [],
    flag: '--compile-gate-command',
    placeholder: 'compile/build/type-check command',
    confirmation_phrase: 'APPLY GARDA SETTING'
  }]
});`, context);

    assert.match(settingsEditorNode.innerHTML, /Команда гейта компиляции/u);
    assert.match(settingsEditorNode.innerHTML, /Не задано в workflow-config/u);
    assert.match(settingsEditorNode.innerHTML, /compile-gate блокируется/u);
    const currentValue = settingsEditorNode.innerHTML.match(/<code class="current-value">([^<]+)<\/code>/u)?.[1] || '';
    assert.match(currentValue, /Не задано в workflow-config/u);
    assert.doesNotMatch(currentValue, /__COMPILE_GATE_COMMAND_UNCONFIGURED__/u);
});

test('workflow setting result renderer shows optional-rule validation errors', () => {
    const workflowNode = {
        innerHTML: '',
        hidden: true,
        setAttribute: () => {},
        getAttribute: () => null,
        scrollIntoView: () => {},
        focus: () => {}
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'en',
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode,
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        outputBlock: (label: string, value: string) => value ? `<pre data-label="${label}">${value}</pre>` : '',
        currentSettingsPayload: null,
        currentWorkflowSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderWorkflowSettingResult({
  setting_id: 'optional-check-rule-management',
  key: 'optional_quality_checks.rules',
  code: 'invalid_setting_value',
  error: 'Optional quality-check rule prompt is required.'
});`, context);

    assert.equal(workflowNode.hidden, false);
    assert.match(workflowNode.innerHTML, /Optional quality-check rule/u);
    assert.match(workflowNode.innerHTML, /invalid_setting_value/u);
    assert.match(workflowNode.innerHTML, /Optional quality-check rule prompt is required\./u);
});

test('workflow settings editor uses optional-rule labels without ordinary-doc text', () => {
    const settingsEditorNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        settingsEditorNode,
        workflowNode: { innerHTML: '', hidden: false },
        workflowPanelTitleNode: { textContent: '' },
        settingStatusNode: { innerHTML: '' },
        currentSettingsPayload: null,
        currentSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderSettingsEditor({
  enabled: true,
  optional_quality_checks: {
    enabled: true,
    rules: [{
      id: 'custom_focus',
      title: 'Custom focus',
      prompt: 'Check custom concern.',
      enabled: true
    }]
  },
  settings: [{
    id: 'optional-checks-enabled',
    key: 'optional_quality_checks.enabled',
    label: 'Optional quality checks',
    description: 'Controls optional checks.',
    current_value: true,
    value_type: 'boolean',
    options: [{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }],
    flag: '--optional-checks-enabled',
    confirmation_phrase: 'APPLY GARDA SETTING'
  }]
});`, context);

    assert.match(settingsEditorNode.innerHTML, /Добавить правило/u);
    assert.match(settingsEditorNode.innerHTML, /Сохранить правило/u);
    assert.match(settingsEditorNode.innerHTML, /Удалить правило/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /Добавить документ/u);
});

test('workflow setting result renderer suppresses routine optional-rule stdout after success', () => {
    const workflowNode = {
        innerHTML: '',
        hidden: true,
        setAttribute: () => {},
        getAttribute: () => null,
        scrollIntoView: () => {},
        focus: () => {}
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'en',
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode,
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        outputBlock: (label: string, value: string) => value ? `<pre data-label="${label}">${value}</pre>` : '',
        currentSettingsPayload: null,
        currentWorkflowSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderWorkflowSettingResult({
  status: 'executed',
  setting_id: 'optional-check-rule-management',
  key: 'optional_quality_checks.rules',
  stdout: 'routine success output '.repeat(200),
  stderr: '',
  audit_path: 'runtime/audit.jsonl'
});`, context);

    assert.equal(workflowNode.hidden, false);
    assert.match(workflowNode.innerHTML, /Optional quality-check rule/u);
    assert.match(workflowNode.innerHTML, /runtime\/audit\.jsonl/u);
    assert.doesNotMatch(workflowNode.innerHTML, /routine success output/u);
    assert.doesNotMatch(workflowNode.innerHTML, /data-label="stdout"/u);
});

test('workflow setting result renderer keeps optional-rule diagnostics on failed execution', () => {
    const workflowNode = {
        innerHTML: '',
        hidden: true,
        setAttribute: () => {},
        getAttribute: () => null,
        scrollIntoView: () => {},
        focus: () => {}
    };
    const context = {
        document: {
            querySelectorAll: () => []
        },
        window: {
            localStorage: null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'en',
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode,
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        outputBlock: (label: string, value: string) => value ? `<pre data-label="${label}">${value}</pre>` : '',
        currentSettingsPayload: null,
        currentWorkflowSettingResult: null,
        currentWorkflowSettingGroup: 'validation'
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\nrenderWorkflowSettingResult({
  status: 'executed',
  setting_id: 'optional-check-rule-management',
  key: 'optional_quality_checks.rules',
  exit_code: 1,
  stdout: 'diagnostic stdout',
  stderr: 'diagnostic stderr'
});`, context);

    assert.match(workflowNode.innerHTML, /diagnostic stdout/u);
    assert.match(workflowNode.innerHTML, /diagnostic stderr/u);
    assert.match(workflowNode.innerHTML, /data-label="stdout"/u);
    assert.match(workflowNode.innerHTML, /data-label="stderr"/u);
});
