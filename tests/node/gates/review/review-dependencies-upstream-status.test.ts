import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assessUpstreamReviewDependencyStatus,
    type ReviewDependencyTimelineEvent
} from '../../../../src/gates/review/review-dependencies';

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function sha256Buffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}




function createReviewDependencyTaxonomyFixture(options: {
    taskId: string;
    receipt?: boolean;
    receiptPreflightSha256?: string;
    context?: boolean;
}): {
    repoRoot: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    timelineEvents: ReviewDependencyTimelineEvent[];
    latestRecordedReviewByType: Map<string, ReviewDependencyTimelineEvent>;
    reviewArtifactPath: string;
    reviewContextPath: string;
    receiptPath: string;
    preflightSha256: string;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependency-taxonomy-'));
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, `${options.taskId}-preflight.json`);
    const preflightPayload = {
        task_id: options.taskId,
        required_reviews: {
            code: true,
            test: true
        },
        review_execution_policy: {
            mode: 'test_after_code'
        }
    };
    writeJson(preflightPath, preflightPayload);
    const preflightSha256 = sha256Buffer(fs.readFileSync(preflightPath));
    const reviewArtifactPath = path.join(reviewsRoot, `${options.taskId}-code.md`);
    const reviewContextPath = path.join(reviewsRoot, `${options.taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${options.taskId}-code-receipt.json`);
    fs.writeFileSync(reviewArtifactPath, [
        '# Review',
        '',
        'Validated current-cycle upstream review dependency diagnostics.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'REVIEW PASSED'
    ].join('\n'), 'utf8');
    if (options.context !== false) {
        writeJson(reviewContextPath, {
            task_id: options.taskId,
            review_type: 'code'
        });
    }
    if (options.receipt !== false) {
        writeJson(receiptPath, {
            task_id: options.taskId,
            review_type: 'code',
            preflight_sha256: options.receiptPreflightSha256 || preflightSha256,
            review_artifact_sha256: sha256Buffer(fs.readFileSync(reviewArtifactPath))
        });
    }
    const recordedEvent: ReviewDependencyTimelineEvent = {
        event_type: 'REVIEW_RECORDED',
        sequence: 2,
        details: {
            review_type: 'code',
            review_context_path: reviewContextPath
        }
    };
    return {
        repoRoot,
        preflightPath,
        preflightPayload,
        timelineEvents: [
            {
                event_type: 'COMPILE_GATE_PASSED',
                sequence: 1,
                details: {
                    preflight_path: preflightPath
                }
            },
            recordedEvent
        ],
        latestRecordedReviewByType: new Map([['code', recordedEvent]]),
        reviewArtifactPath,
        reviewContextPath,
        receiptPath,
        preflightSha256
    };
}

test('assessUpstreamReviewDependencyStatus classifies missing receipt blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-missing-receipt',
        receipt: false
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-missing-receipt',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'missing_receipt');
        assert.match(result.reason, /missing or invalid review receipt JSON/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus classifies stale freshness blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-stale-freshness',
        receiptPreflightSha256: '0'.repeat(64)
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-stale-freshness',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'stale_freshness');
        assert.match(result.reason, /not bound to the current preflight/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus classifies missing context blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-missing-context',
        context: false
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-missing-context',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'missing_context');
        assert.match(result.reason, /missing or invalid review-context artifact/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});
