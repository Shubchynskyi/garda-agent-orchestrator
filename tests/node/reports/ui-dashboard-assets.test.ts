import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../src/core/constants';
import { UI_DASHBOARD_CLIENT_CORE } from '../../../src/reports/ui/dashboard/dashboard-client-core';
import { UI_DASHBOARD_CLIENT_QUALITY_GATE } from '../../../src/reports/ui/dashboard/dashboard-client-quality-gate';
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
    assert.match(html, /data-tab="quality-gate-tab"/u);
    assert.match(html, /function renderTasks\(report\)/u);
    assert.match(html, /function renderWorkflow\(report\)/u);
    assert.match(html, /function renderQualityGate\(report\)/u);
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

test('workflow setting result renderer suppresses routine quality-gate stdout after success', () => {
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

    const script = `${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}`;

    vm.runInNewContext(`${script}\nrenderWorkflowSettingResult({
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

    vm.runInNewContext(`renderWorkflowSettingResult({
  status: 'executed',
  setting_id: 'optional-checks-enabled',
  key: 'optional_quality_checks.enabled',
  stdout: 'workflow set success output '.repeat(200),
  stderr: '',
  audit_path: 'runtime/toggle-audit.jsonl'
});`, context);

    assert.match(workflowNode.innerHTML, /Optional quality checks/u);
    assert.match(workflowNode.innerHTML, /runtime\/toggle-audit\.jsonl/u);
    assert.doesNotMatch(workflowNode.innerHTML, /workflow set success output/u);
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

test('quality gate tab renders baseline custom deleted and edited rule status', () => {
    const qualityGateNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => [],
            getElementById: () => null
        },
        window: {
            localStorage: null,
            prompt: () => null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        qualityGateNode,
        qualityGateStatusNode: {
            innerHTML: '',
            classList: { toggle: () => {} }
        },
        qualityGateConfigPathNode: { textContent: '' },
        settingsEditorNode: {
            innerHTML: '',
            querySelectorAll: () => []
        },
        workflowNode: { innerHTML: '', hidden: false },
        workflowPanelTitleNode: { textContent: '' },
        workflowConfigPathNode: { textContent: '' },
        currentSettingsPayload: {
            enabled: false,
            settings: [],
            quality_gate: {
                config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
                status: 'present',
                enabled: true,
                baseline_version: '2026-06-25.t839',
                shipped_baseline_version: '2026-06-25.t839',
                baseline_rule_count: 1,
                custom_rule_count: 1,
                deleted_baseline_rule_count: 1,
                unavailable: [],
                rules: [
                    {
                        id: 'code_simplification',
                        title: 'Code simplification',
                        prompt: 'Changed locally.',
                        enabled: true,
                        present: true,
                        source: 'baseline',
                        statuses: ['locally_edited']
                    },
                    {
                        id: 'custom_focus',
                        title: 'Custom focus',
                        prompt: 'Check custom concern.',
                        enabled: false,
                        present: true,
                        source: 'custom',
                        statuses: ['disabled']
                    },
                    {
                        id: 'zero_diff_noop_preemption',
                        title: 'Zero-diff no-op preemption',
                        prompt: 'Check no-op routing.',
                        enabled: false,
                        present: false,
                        source: 'baseline',
                        statuses: ['deleted']
                    }
                ]
            }
        },
        currentReport: null,
        currentQualityGateSettingResult: null
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\n${UI_DASHBOARD_CLIENT_QUALITY_GATE}\nrenderQualityGate(null);`, context);

    assert.match(qualityGateNode.innerHTML, /Поставляемый baseline/u);
    assert.match(qualityGateNode.innerHTML, /Изменено локально/u);
    assert.match(qualityGateNode.innerHTML, /Пользовательское/u);
    assert.match(qualityGateNode.innerHTML, /Отключено/u);
    assert.match(qualityGateNode.innerHTML, /Удалено/u);
    assert.match(qualityGateNode.innerHTML, /garda ui --actions/u);
});
