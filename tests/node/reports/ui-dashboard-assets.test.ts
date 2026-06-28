import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../src/core/constants';
import { UI_DASHBOARD_CLIENT_CORE } from '../../../src/reports/ui/dashboard/dashboard-client-core';
import { UI_DASHBOARD_CLIENT_PROFILES } from '../../../src/reports/ui/dashboard/dashboard-client-profiles';
import { UI_DASHBOARD_CLIENT_QUALITY_GATE } from '../../../src/reports/ui/dashboard/dashboard-client-quality-gate';
import { UI_DASHBOARD_CLIENT_SESSION_ACTIONS } from '../../../src/reports/ui/dashboard/dashboard-client-session-actions';
import { UI_DASHBOARD_CLIENT_WORKFLOW } from '../../../src/reports/ui/dashboard/dashboard-client-workflow';
import { UI_DASHBOARD_STYLES } from '../../../src/reports/ui/dashboard/dashboard-styles';
import { renderLocalUiHtml } from '../../../src/reports/ui/ui-dashboard-html';
import {
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_SETTING_TEXT,
    LOCAL_UI_TEXT
} from '../../../src/reports/ui/ui-i18n';

const DASHBOARD_ASSET_DIR = join(process.cwd(), 'src/reports/ui/dashboard');

function htmlTagById(html: string, tagName: string, id: string): string {
    const pattern = new RegExp(`<${tagName}\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'u');
    const match = html.match(pattern);
    assert.ok(match, `Expected <${tagName}> with id '${id}'.`);
    return match[0];
}

function htmlButtonByRuleAction(html: string, ruleId: string, action: string): string {
    const rulePattern = `data-quality-gate-rule-id="${ruleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`;
    const actionPattern = `data-quality-gate-rule-action="${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`;
    const pattern = new RegExp(`<button\\b(?=[^>]*\\b${rulePattern})(?=[^>]*\\b${actionPattern})[^>]*>`, 'u');
    const match = html.match(pattern);
    assert.ok(match, `Expected quality-gate ${action} button for '${ruleId}'.`);
    return match[0];
}

function htmlTagHasDisabled(tag: string): boolean {
    return /\sdisabled(?:\s|>|=)/u.test(tag);
}

function renderQualityGateHtml(
    qualityGate: Record<string, unknown>,
    actionsEnabled: boolean,
    initialLanguage = 'ru'
): string {
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
        initialLanguage,
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
            enabled: actionsEnabled,
            settings: [],
            quality_gate: qualityGate
        },
        currentReport: null,
        currentQualityGateSettingResult: null
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\n${UI_DASHBOARD_CLIENT_QUALITY_GATE}\nrenderQualityGate(null);`, context);
    return qualityGateNode.innerHTML;
}

function renderProfilesHtml(
    profilesTab: Record<string, unknown>,
    actionsEnabled: boolean,
    initialLanguage = 'en'
): string {
    const profilesNode = {
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
        initialLanguage,
        profilesNode,
        profilesStatusNode: { innerHTML: '' },
        profilesConfigPathNode: { textContent: '' },
        currentProfilesPayload: null,
        actionToken: 'test-token',
        fetch: async () => ({ json: async () => ({}) })
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_WORKFLOW}\n${UI_DASHBOARD_CLIENT_PROFILES}\nrenderProfiles(${JSON.stringify({
        enabled: actionsEnabled,
        ...profilesTab
    })});`, context);
    return profilesNode.innerHTML;
}

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
    assert.match(UI_DASHBOARD_STYLES, /quality-gate-rule-table/u);
    assert.doesNotMatch(UI_DASHBOARD_STYLES, /min-width: 1040px/u);
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

test('workflow settings editor omits optional-rule management controls', () => {
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

    assert.match(settingsEditorNode.innerHTML, /optional_quality_checks\.enabled/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /data-optional-rule-action=/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /optional-rules-editor/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /Добавить правило/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /Сохранить правило/u);
    assert.doesNotMatch(settingsEditorNode.innerHTML, /Удалить правило/u);
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

    vm.runInNewContext(`renderWorkflowSettingResult({
  status: 'executed',
  setting_id: 'task-reset-enabled',
  key: 'task_reset.enabled',
  changed_keys: ['task_reset.enabled'],
  stdout: 'task reset workflow set success output '.repeat(250),
  stderr: '',
  audit_path: 'runtime/task-reset-audit.jsonl'
});`, context);

    assert.match(workflowNode.innerHTML, /Task reset/u);
    assert.match(workflowNode.innerHTML, /task_reset\.enabled/u);
    assert.match(workflowNode.innerHTML, /runtime\/task-reset-audit\.jsonl/u);
    assert.doesNotMatch(workflowNode.innerHTML, /task reset workflow set success output/u);
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
                baseline_version: '2026-06-27.t846',
                shipped_baseline_version: '2026-06-27.t846',
                baseline_version_label: '2026-06-27 (T-846)',
                shipped_baseline_version_label: '2026-06-27 (T-846)',
                baseline_rule_count: 1,
                custom_rule_count: 1,
                deleted_baseline_rule_count: 1,
                latest_check: {
                    artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-100-quality-checklist.json',
                    artifact_exists: true,
                    evidence_status: 'current',
                    checklist_status: 'ACTION_REQUIRED',
                    outcome: 'FAIL',
                    effect: 'required_rework',
                    summary: 'Quality checklist required rework (1 action item).',
                    stale_reasons: [],
                    task_id: 'T-100',
                    timestamp_utc: '2026-05-16T00:00:00.000Z',
                    preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-100-preflight.json',
                    preflight_sha256: '1'.repeat(64),
                    workflow_config_sha256: '2'.repeat(64),
                    changed_files_count: 2,
                    changed_files_preview: ['src/reports/report-data/quality-gate-evidence.ts'],
                    changed_files_truncated: false,
                    enabled_rule_count: 1,
                    answer_count: 1,
                    action_taken_count: 0,
                    action_required_count: 1,
                    actions_taken: [],
                    actions_required: ['Extract parser helpers before review.'],
                    answers: [{
                        rule_id: 'code_simplification',
                        status: 'WARN',
                        answer: 'Central parser helpers still need a smaller shape.',
                        evidence_files: ['src/reports/report-data/quality-gate-evidence.ts'],
                        actions_taken: ['Bounded answer summary rendering added.'],
                        actions_required: ['Extract parser helpers before review.']
                    }],
                    timeline_event_count: 1,
                    latest_timeline_event_utc: '2026-05-16T00:00:00.000Z'
                },
                action_required_history: [{
                    task_id: 'T-100',
                    timestamp_utc: '2026-05-16T00:00:00.000Z',
                    artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-100-quality-checklist.json',
                    evidence_status: 'current',
                    action_required_count: 1,
                    actions_required: ['Extract parser helpers before review.'],
                    changed_files_count: 2,
                    changed_files_preview: ['src/reports/report-data/quality-gate-evidence.ts']
                }],
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
                        id: 'duplicated_logic_contracts',
                        title: 'Duplicated logic and contracts',
                        prompt: 'Check duplicated logic.',
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

    assert.doesNotMatch(qualityGateNode.innerHTML, /Поставляемый baseline/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Текущий baseline/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Удалённые baseline-правила/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /2026-06-27\.t846/u);
    assert.equal(context.qualityGateConfigPathNode.textContent, '');
    assert.match(qualityGateNode.innerHTML, /Установленный набор правил/u);
    assert.match(qualityGateNode.innerHTML, /Поставляемый набор правил/u);
    assert.match(qualityGateNode.innerHTML, /2026-06-27 \(T-846\)/u);
    assert.match(qualityGateNode.innerHTML, /Изменено локально/u);
    assert.match(qualityGateNode.innerHTML, /Пользовательское/u);
    assert.match(qualityGateNode.innerHTML, /Отключено/u);
    assert.match(qualityGateNode.innerHTML, /Удалено/u);
    assert.match(qualityGateNode.innerHTML, /quality-gate-rule-table/u);
    assert.match(qualityGateNode.innerHTML, /code_simplification/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Последняя проверка/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Требует доработки/u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Central parser helpers still need a smaller shape\./u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Bounded answer summary rendering added\./u);
    assert.doesNotMatch(qualityGateNode.innerHTML, /Extract parser helpers before review\./u);
    assert.match(qualityGateNode.innerHTML, /garda ui --actions/u);
});

test('quality gate rule table renders long localized disabled rows in responsive layout', () => {
    const longRuleId = 'baseline_quality_rule_with_long_unbroken_identifier_for_wrap_regression_0123456789';
    const longTitle = 'LongUnbrokenQualityGateRuleTitleThatMustStayInsideTheRulesTableWithoutExpandingTheTab';
    const longPrompt = 'LongUnbrokenQualityGateRulePromptThatExercisesOverflowWrappingForTheRuleDescriptionCellAndInputValue';
    const html = renderQualityGateHtml({
        config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
        status: 'present',
        enabled: true,
        baseline_rule_count: 1,
        custom_rule_count: 0,
        unavailable: [],
        rules: [{
            id: longRuleId,
            title: longTitle,
            prompt: longPrompt,
            enabled: false,
            present: true,
            source: 'baseline',
            statuses: ['disabled']
        }]
    }, false, 'ru');

    assert.match(html, /workflow-table quality-gate-rule-table/u);
    assert.match(html, new RegExp(longRuleId, 'u'));
    assert.match(html, new RegExp(longTitle, 'u'));
    assert.match(html, new RegExp(longPrompt, 'u'));
    assert.match(html, /Базовое/u);
    assert.match(html, /Отключено/u);
    assert.match(html, /Сохранение отключено/u);
    assert.match(UI_DASHBOARD_STYLES, /\.quality-gate-rule-table th, \.quality-gate-rule-table td \{ overflow-wrap: anywhere; \}/u);
    assert.match(UI_DASHBOARD_STYLES, /\.quality-gate-rule-table input, \.quality-gate-rule-table select \{ width: 100%; min-width: 0; \}/u);
});

test('quality gate rule table renders new custom row before custom rules and baseline rules', () => {
    const html = renderQualityGateHtml({
        config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
        status: 'present',
        enabled: true,
        baseline_rule_count: 1,
        custom_rule_count: 1,
        unavailable: [],
        rules: [
            {
                id: 'code_simplification',
                title: 'Code simplification',
                prompt: 'Check simplification.',
                enabled: true,
                present: true,
                source: 'baseline',
                statuses: ['active']
            },
            {
                id: 'custom_focus',
                title: 'Custom focus',
                prompt: 'Check custom concern.',
                enabled: true,
                present: true,
                source: 'custom',
                statuses: ['active']
            }
        ]
    }, true);

    const newRuleIndex = html.indexOf('data-optional-rule-id="quality-gate-new"');
    const customRuleIndex = html.indexOf('data-optional-rule-id="custom_focus"');
    const baselineRuleIndex = html.indexOf('data-optional-rule-id="code_simplification"');
    assert.ok(newRuleIndex >= 0, 'Expected the new custom rule row to render.');
    assert.ok(customRuleIndex >= 0, 'Expected the custom rule row to render.');
    assert.ok(baselineRuleIndex >= 0, 'Expected the baseline rule row to render.');
    assert.ok(newRuleIndex < customRuleIndex, 'Expected the new custom rule row before existing custom rules.');
    assert.ok(customRuleIndex < baselineRuleIndex, 'Expected custom rules before baseline rules.');
});

test('system state renders quality baseline diagnostics with localized labels', () => {
    const systemStateNode = {
        innerHTML: '',
        querySelectorAll: () => []
    };
    const context = {
        document: {
            querySelectorAll: () => [],
            getElementById: (id: string) => id === 'system-state-panel' ? systemStateNode : null
        },
        window: {
            localStorage: null,
            prompt: () => null
        },
        languageMetadata: LOCAL_UI_LANGUAGES,
        languagePacks: LOCAL_UI_TEXT,
        settingTextPacks: LOCAL_UI_SETTING_TEXT,
        actionTextPacks: {},
        actionCategoryTextPacks: {},
        fallbackLanguage: 'en',
        initialLanguage: 'ru',
        actionToken: '',
        currentActionsPayload: null,
        currentReport: null,
        gardaSwitchNode: null,
        actionStatusNode: { innerHTML: '' },
        sessionSummaryNode: { innerHTML: '' },
        sessionCountdownNode: { max: '', value: '' },
        sessionPollTimer: null,
        lastActivityPingAt: 0,
        fetch: async () => ({ json: async () => ({}) }),
        setInterval: () => 0,
        clearInterval: () => {}
    };

    vm.runInNewContext(`${UI_DASHBOARD_CLIENT_CORE}\n${UI_DASHBOARD_CLIENT_SESSION_ACTIONS}\nrenderSystemState({
        generated_at_utc: '2026-05-16T00:00:00.000Z',
        system_state: {
            overall: { status: 'attention', label: 'Needs attention', summary: 'One or more System State signals need attention.', generated_at_utc: '2026-05-16T00:00:00.000Z' },
            garda: null,
            ui_actions: null,
            task_queue: null,
            workflow: null,
            quality_baseline: {
                id: 'quality-baseline',
                label: 'Installed quality rules',
                status: 'attention',
                summary: 'Installed quality rule-pack version is older than the shipped baseline.',
                remediation: 'Run update or workflow validation.',
                value: {
                    installed_baseline_version: '2026-06-25.t842',
                    shipped_baseline_version: '2026-06-27.t846',
                    installed_baseline_rule_count: 9,
                    shipped_baseline_rule_count: 12,
                    missing_shipped_rule_ids: ['duplicated_logic_contracts']
                },
                source_path: 'garda-agent-orchestrator/live/config/workflow-config.json'
            },
            project_memory: null,
            protected_manifest: null,
            runtime: {},
            configuration_files: [],
            signals: []
        }
    });`, context);

    assert.match(systemStateNode.innerHTML, /Установленные правила качества/u);
    assert.match(systemStateNode.innerHTML, /Установленный набор правил/u);
    assert.match(systemStateNode.innerHTML, /Поставляемый набор правил/u);
    assert.match(systemStateNode.innerHTML, /2026-06-25 \(T-842\)/u);
    assert.match(systemStateNode.innerHTML, /2026-06-27 \(T-846\)/u);
    assert.doesNotMatch(systemStateNode.innerHTML, /2026-06-25\.t842/u);
    assert.match(systemStateNode.innerHTML, /Отсутствующие поставляемые правила/u);
    assert.match(systemStateNode.innerHTML, /duplicated_logic_contracts/u);
});

test('quality gate tab keeps baseline rule content immutable while enabled state remains editable', () => {
    const html = renderQualityGateHtml({
        config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
        status: 'present',
        enabled: true,
        baseline_version: '2026-06-27.t846',
        shipped_baseline_version: '2026-06-27.t846',
        baseline_version_label: '2026-06-27 (T-846)',
        shipped_baseline_version_label: '2026-06-27 (T-846)',
        baseline_rule_count: 1,
        custom_rule_count: 1,
        deleted_baseline_rule_count: 0,
        latest_check: {
            evidence_status: 'missing',
            stale_reasons: [],
            actions_taken: [],
            actions_required: [],
            answers: []
        },
        action_required_history: [],
        unavailable: [],
        rules: [
            {
                id: 'code_simplification',
                title: 'Code simplification',
                prompt: 'Check simplification.',
                enabled: true,
                present: true,
                source: 'baseline',
                statuses: ['active']
            },
            {
                id: 'custom_focus',
                title: 'Custom focus',
                prompt: 'Check custom concern.',
                enabled: false,
                present: true,
                source: 'custom',
                statuses: ['disabled']
            }
        ]
    }, true);

    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-code_simplification-title')), true);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-code_simplification-prompt')), true);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'select', 'optional-rule-code_simplification-enabled')), false);
    assert.equal(htmlTagHasDisabled(htmlButtonByRuleAction(html, 'code_simplification', 'upsert')), false);
    assert.equal(htmlTagHasDisabled(htmlButtonByRuleAction(html, 'code_simplification', 'delete')), true);

    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-custom_focus-title')), false);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'input', 'optional-rule-custom_focus-prompt')), false);
    assert.equal(htmlTagHasDisabled(htmlTagById(html, 'select', 'optional-rule-custom_focus-enabled')), false);
    assert.equal(htmlTagHasDisabled(htmlButtonByRuleAction(html, 'custom_focus', 'delete')), false);
});

test('profiles tab renders required auto disabled policy controls without trigger editors', () => {
    const html = renderProfilesHtml({
        status: 'present',
        config_path: 'garda-agent-orchestrator/live/config/profiles.json',
        active_profile: 'balanced',
        unavailable: [],
        review_types: [
            { id: 'code', label: 'Code' },
            { id: 'test', label: 'Test' },
            { id: 'performance', label: 'Performance' }
        ],
        profiles: [
            {
                name: 'custom-review',
                source: 'user',
                protected: false,
                active: false,
                description: 'Custom profile',
                depth: 2,
                review_policy: {
                    code: true,
                    test: 'auto',
                    performance: false
                }
            },
            {
                name: 'balanced',
                source: 'built_in',
                protected: true,
                active: true,
                description: 'Default profile',
                depth: 2,
                review_policy: {
                    code: true,
                    test: true,
                    performance: 'auto'
                }
            }
        ]
    }, true);

    assert.match(html, /id="profile-custom-review-review-code"[\s\S]*<option value="required" selected>[\s\S]*?<\/option>[\s\S]*<option value="auto">[\s\S]*?<\/option>[\s\S]*<option value="disabled">[\s\S]*?<\/option>/u);
    assert.match(html, /id="profile-custom-review-review-test"[\s\S]*<option value="required">[\s\S]*?<\/option>[\s\S]*<option value="auto" selected>[\s\S]*?<\/option>[\s\S]*<option value="disabled">[\s\S]*?<\/option>/u);
    assert.match(html, /id="profile-custom-review-review-performance"[\s\S]*<option value="required">[\s\S]*?<\/option>[\s\S]*<option value="auto">[\s\S]*?<\/option>[\s\S]*<option value="disabled" selected>[\s\S]*?<\/option>/u);
    assert.doesNotMatch(html, /data-profile-trigger|profileTrigger|review_trigger/u);
});
