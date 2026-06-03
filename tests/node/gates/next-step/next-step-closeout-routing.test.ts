import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveCompletedCloseoutRouteFromState,
    resolvePostReviewCloseoutRouteFromState
} from '../../../../src/gates/next-step/next-step-closeout-routing';

describe('next-step closeout routing helpers', () => {
    it('builds project-memory closeout routing from flat post-review state', () => {
        const route = resolvePostReviewCloseoutRouteFromState({
            requiredReviewsGatePassed: true,
            zeroDiffNoReviewCloseout: false,
            requiredReviewsCommand: 'garda gate required-reviews-check',
            docImpactGatePassed: true,
            docImpactCompatibilityHint: 'No compatibility issue.',
            docImpactCommand: 'garda gate doc-impact-gate',
            fullSuiteEnabled: false,
            fullSuiteGatePassed: false,
            fullSuiteNotRequiredForDocsOnly: false,
            fullSuitePlacement: 'before_completion',
            fullSuiteConfigPath: 'workflow-config.json',
            fullSuiteCommandText: 'npm test',
            fullSuiteTimeoutForecastLine: null,
            fullSuiteCommand: 'garda gate full-suite-validation',
            projectMemoryRequired: true,
            projectMemoryEvidenceCurrent: false,
            projectMemoryVisibleSummaryLine: 'project memory required',
            projectMemoryAffectedMemoryFiles: ['live/docs/project-memory/module-map.md'],
            projectMemoryViolations: ['missing current evidence'],
            projectMemoryCommand: 'garda gate project-memory-impact',
            completionGatePassed: false,
            completionCommand: 'garda gate completion-gate'
        });

        assert.equal(route.status, 'BLOCKED');
        assert.equal(route.nextGate, 'project-memory-impact');
        assert.equal(route.commands[0].label, 'Run project memory impact gate');
        assert.equal(route.commands[0].command, 'garda gate project-memory-impact');
        assert.match(route.reason, /live\/docs\/project-memory\/module-map\.md/);
        assert.match(route.reason, /missing current evidence/);
    });

    it('builds completed closeout routing with final audit command label', () => {
        const route = resolveCompletedCloseoutRouteFromState({
            postDoneDriftBlocked: false,
            postDoneDriftReason: 'No materialized final closeout artifact exists yet.',
            finalReportContractReady: true,
            finalReportContractBlocker: '',
            finalReport: null,
            taskAuditCommand: 'garda gate task-audit-summary'
        });

        assert.equal(route.status, 'READY');
        assert.equal(route.nextGate, 'task-audit-summary');
        assert.equal(route.commands[0].label, 'Build final audit summary');
        assert.equal(route.commands[0].command, 'garda gate task-audit-summary');
        assert.equal(route.finalReport, null);
    });

    it('returns materialized final report unchanged when completed closeout is done', () => {
        const finalReport = {
            required_order: ['summary', 'final report'],
            final_user_report_path: 'runtime/reviews/T-1-final-user-report.md'
        };

        const route = resolveCompletedCloseoutRouteFromState({
            postDoneDriftBlocked: false,
            postDoneDriftReason: 'No drift.',
            finalReportContractReady: true,
            finalReportContractBlocker: '',
            finalReport,
            taskAuditCommand: 'garda gate task-audit-summary'
        });

        assert.equal(route.status, 'DONE');
        assert.equal(route.nextGate, null);
        assert.equal(route.commands.length, 0);
        assert.equal(route.finalReport, finalReport);
    });
});
