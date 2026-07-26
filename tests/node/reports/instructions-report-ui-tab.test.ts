import test from 'node:test';
import assert from 'node:assert/strict';
import {
    INSTRUCTIONS_REPORT_UI_TAB_CONTRACT,
    REPORT_UI_TAB_CONTRACT_MIGRATION_CHECKLIST,
    REPORT_UI_TAB_CONTRACT_MIGRATION_STEPS,
    buildInstructionsReportUiTabMetadata
} from '../../../src/reports/report-data-contract';
import { STATIC_HTML_REPORT_TABS } from '../../../src/reports/static-html/document';
import { renderInstructionsPanel } from '../../../src/reports/static-html/instructions-tab';
import { renderDashboardBodyMarkup } from '../../../src/reports/ui/dashboard';
import { buildDashboardClientPrelude } from '../../../src/reports/ui/dashboard/dashboard-client-prelude';
import { LOCAL_UI_TEXT } from '../../../src/reports/ui/ui-i18n';
import type { ReportDataContract } from '../../../src/reports/report-data-contract';

test('instructions tab contract resolves stable shared metadata', () => {
    assert.deepEqual(buildInstructionsReportUiTabMetadata({ entries: [] }), {
        id: 'instructions',
        label: {
            key: 'instructionsTab',
            fallback: 'Instructions'
        },
        status: 'empty',
        paths: []
    });
    assert.equal(buildInstructionsReportUiTabMetadata({
        entries: [{ id: 'task-execution', title: 'Task execution', body: 'Run the task.' }]
    }).status, 'present');
});

test('instructions pilot preserves static report data and contract identity', () => {
    const report = {
        instructions_tab: {
            entries: [{
                id: 'task-execution',
                title: 'Build <report>',
                body: 'Run `garda next-step`.'
            }]
        },
        unavailable: []
    } as unknown as ReportDataContract;

    const html = renderInstructionsPanel(report);

    assert.match(html, new RegExp(`id="tab-${INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.id}"`, 'u'));
    assert.match(html, /data-status="present"/u);
    assert.match(html, /Build &lt;report&gt;/u);
    assert.match(html, /Run `garda next-step`\./u);
});

test('instructions pilot renders the empty static panel status', () => {
    const report = {
        instructions_tab: { entries: [] },
        unavailable: []
    } as unknown as ReportDataContract;

    const html = renderInstructionsPanel(report);

    assert.match(html, /id="tab-instructions"/u);
    assert.match(html, /data-status="empty"/u);
});

test('instructions pilot wires shared identity through static navigation and dashboard client', () => {
    const staticTab = STATIC_HTML_REPORT_TABS.find(
        (tab) => tab.id === INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.id
    );
    const clientPrelude = buildDashboardClientPrelude({
        actionToken: 'test-token',
        actionsEnabled: false,
        initialLanguage: 'en'
    });

    assert.deepEqual(staticTab, {
        id: INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.id,
        label: INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.label.fallback
    });
    assert.match(
        clientPrelude,
        new RegExp(
            `const instructionsNode = document\\.getElementById\\(${JSON.stringify(
                INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.id
            )}\\);`,
            'u'
        )
    );
});

test('instructions pilot preserves localized dashboard labels', () => {
    const html = renderDashboardBodyMarkup(LOCAL_UI_TEXT.de, false);

    assert.match(
        html,
        new RegExp(`data-tab="${INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.id}-tab"`, 'u')
    );
    assert.match(
        html,
        new RegExp(`data-i18n="${INSTRUCTIONS_REPORT_UI_TAB_CONTRACT.label.key}"`, 'u')
    );
    assert.match(html, />Anweisungen<\/button>/u);
    assert.match(html, />Anweisungen<\/h2>/u);
});

test('instructions pilot records the remaining shared-tab migration checklist', () => {
    assert.equal(REPORT_UI_TAB_CONTRACT_MIGRATION_CHECKLIST.instructions, 'pilot-migrated');
    assert.deepEqual(
        Object.entries(REPORT_UI_TAB_CONTRACT_MIGRATION_CHECKLIST)
            .filter(([, status]) => status === 'pending')
            .map(([tabId]) => tabId),
        ['tasks', 'quality-gate', 'workflow', 'init-settings', 'project-memory', 'backups']
    );
    assert.deepEqual(REPORT_UI_TAB_CONTRACT_MIGRATION_STEPS, [
        'define-shared-contract',
        'consume-id-and-label-in-static-html',
        'consume-id-and-localized-label-in-dashboard',
        'preserve-status-path-and-action-behavior',
        'add-static-and-dashboard-render-tests'
    ]);
});
