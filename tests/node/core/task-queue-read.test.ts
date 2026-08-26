import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    parseTaskQueueEntriesFromContent,
    readTaskQueueEntries
} from '../../../src/core/task-queue-read';
import { formatReviewFollowUpTaskClosurePolicyMetadata } from '../../../src/core/review-follow-up-task-closure-policy';

function taskQueueContent(): string {
    return [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
        '| not a task | TODO | P2 | misc | Ignored row | codex | 2026-07-09 | balanced | invalid id |',
        ''
    ].join('\n');
}

test('parseTaskQueueEntriesFromContent preserves canonical TASK.md queue parsing fields', () => {
    const entries = parseTaskQueueEntriesFromContent(taskQueueContent());
    const entry = entries.get('T-100');

    assert.deepEqual([...entries.keys()], ['T-100']);
    assert.deepEqual({
        taskId: entry?.taskId,
        status: entry?.status,
        area: entry?.area,
        title: entry?.title,
        profile: entry?.profile,
        notes: entry?.notes
    }, {
        taskId: 'T-100',
        status: 'IN_PROGRESS',
        area: 'core/helpers',
        title: 'Centralize helpers',
        profile: 'strict',
        notes: 'child tasks: T-100-1'
    });
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.eligible, false);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.configured, false);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.valid, true);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.source_notes_sha256, null);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.skip_low_findings, false);
    assert.equal(entry?.reviewFollowUpTaskClosurePolicy?.forbid_child_tasks, false);
});

test('task queue resolves all four explicit follow-up closure policy combinations independently', () => {
    const fingerprint = 'a'.repeat(64);
    for (const skipLowFindings of [false, true]) {
        for (const forbidChildTasks of [false, true]) {
            const taskId = `T-100-F-${Number(skipLowFindings)}-${Number(forbidChildTasks)}`;
            const policyMetadata = formatReviewFollowUpTaskClosurePolicyMetadata({
                skip_low_findings: skipLowFindings,
                forbid_child_tasks: forbidChildTasks
            });
            const content = taskQueueContent().replace(
                '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
                `| ${taskId} | TODO | P1 | review/follow-up | Close findings | codex | 2026-07-09 | strict | ` +
                `Child of \`T-100\`. review_follow_up_fingerprint=${fingerprint}. ${policyMetadata} |`
            );

            const policy = parseTaskQueueEntriesFromContent(content)
                .get(taskId)?.reviewFollowUpTaskClosurePolicy;

            assert.equal(policy?.eligible, true);
            assert.equal(policy?.configured, true);
            assert.equal(policy?.valid, true);
            assert.equal(policy?.provenance, 'per_finding');
            assert.equal(policy?.skip_low_findings, skipLowFindings);
            assert.equal(policy?.forbid_child_tasks, forbidChildTasks);
            assert.match(policy?.source_notes_sha256 || '', /^[a-f0-9]{64}$/u);
        }
    }
});

test('task queue treats grouped nested legacy follow-ups as eligible with compatible off defaults', () => {
    const fingerprint = 'b'.repeat(64);
    const content = taskQueueContent().replace(
        '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
        '| T-100-F1-F1 | TODO | P1 | review/follow-up | Legacy grouped follow-up | codex | 2026-07-09 | strict | ' +
        `Child of \`T-100-F1\`. review_follow_up_group_fingerprint=${fingerprint}. |`
    );

    const policy = parseTaskQueueEntriesFromContent(content)
        .get('T-100-F1-F1')?.reviewFollowUpTaskClosurePolicy;

    assert.equal(policy?.eligible, true);
    assert.equal(policy?.configured, false);
    assert.equal(policy?.valid, true);
    assert.equal(policy?.provenance, 'grouped_by_parent');
    assert.equal(policy?.skip_low_findings, false);
    assert.equal(policy?.forbid_child_tasks, false);
});

test('task queue never infers follow-up closure eligibility from an F-shaped task id', () => {
    const content = taskQueueContent().replace(
        '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
        '| T-100-F1 | TODO | P1 | review/follow-up | Unproven follow-up | codex | 2026-07-09 | strict | Child of `T-100`. |'
    );

    const policy = parseTaskQueueEntriesFromContent(content)
        .get('T-100-F1')?.reviewFollowUpTaskClosurePolicy;

    assert.equal(policy?.eligible, false);
    assert.equal(policy?.valid, true);
    assert.equal(policy?.skip_low_findings, false);
    assert.equal(policy?.forbid_child_tasks, false);
});

test('task queue rejects prefixed or case-variant provenance keys instead of authorizing closure controls', () => {
    const fingerprint = 'd'.repeat(64);
    const policyMetadata = formatReviewFollowUpTaskClosurePolicyMetadata({
        skip_low_findings: true,
        forbid_child_tasks: true
    });
    for (const [index, provenanceKey] of [
        'xreview_follow_up_fingerprint',
        'xreview_follow_up_group_fingerprint',
        'Review_Follow_Up_Fingerprint',
        'Review_Follow_Up_Group_Fingerprint'
    ].entries()) {
        const taskId = `T-100-prefixed-provenance-${index + 1}`;
        const content = taskQueueContent().replace(
            '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
            `| ${taskId} | TODO | P1 | review/follow-up | Prefixed provenance | codex | 2026-07-09 | strict | ` +
            `${provenanceKey}=${fingerprint}. ${policyMetadata} |`
        );

        const policy = parseTaskQueueEntriesFromContent(content)
            .get(taskId)?.reviewFollowUpTaskClosurePolicy;

        assert.equal(policy?.eligible, false, provenanceKey);
        assert.equal(policy?.configured, true, provenanceKey);
        assert.equal(policy?.valid, false, provenanceKey);
        assert.equal(policy?.provenance, null, provenanceKey);
        assert.equal(policy?.skip_low_findings, false, provenanceKey);
        assert.equal(policy?.forbid_child_tasks, false, provenanceKey);
    }
});

test('task queue ignores prefixed or case-variant closure policy keys and keeps eligible defaults off', () => {
    const fingerprint = 'e'.repeat(64);
    const policyMetadata = formatReviewFollowUpTaskClosurePolicyMetadata({
        skip_low_findings: true,
        forbid_child_tasks: true
    });
    const noncanonicalPolicyMetadata = [
        `x${policyMetadata}`,
        policyMetadata.replace(
            'review_follow_up_task_closure_policy',
            'Review_Follow_Up_Task_Closure_Policy'
        )
    ];
    for (const [index, metadata] of noncanonicalPolicyMetadata.entries()) {
        const taskId = `T-100-noncanonical-policy-${index + 1}`;
        const content = taskQueueContent().replace(
            '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
            `| ${taskId} | TODO | P1 | review/follow-up | Noncanonical policy | codex | 2026-07-09 | strict | ` +
            `review_follow_up_fingerprint=${fingerprint}. ${metadata} |`
        );

        const policy = parseTaskQueueEntriesFromContent(content)
            .get(taskId)?.reviewFollowUpTaskClosurePolicy;

        assert.equal(policy?.eligible, true, metadata);
        assert.equal(policy?.configured, false, metadata);
        assert.equal(policy?.valid, true, metadata);
        assert.equal(policy?.provenance, 'per_finding', metadata);
        assert.equal(policy?.skip_low_findings, false, metadata);
        assert.equal(policy?.forbid_child_tasks, false, metadata);
    }
});

test('task queue fails malformed or inapplicable follow-up closure metadata closed', () => {
    const fingerprint = 'c'.repeat(64);
    const cases = [
        {
            taskId: 'T-100-invalid-json',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":"yes","forbid_child_tasks":true}`.'
        },
        {
            taskId: 'T-100-no-provenance',
            notes: formatReviewFollowUpTaskClosurePolicyMetadata({
                skip_low_findings: true,
                forbid_child_tasks: true
            })
        },
        {
            taskId: 'T-100-ambiguous',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                `review_follow_up_group_fingerprint=${fingerprint}. ` +
                formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: true
                })
        },
        {
            taskId: 'T-100-suffixed-per-finding-provenance',
            notes: `review_follow_up_fingerprint=${fingerprint}.suffix ` +
                formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: true
                })
        },
        {
            taskId: 'T-100-suffixed-grouped-provenance',
            notes: `review_follow_up_group_fingerprint=${fingerprint}.suffix ` +
                formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: true
                })
        },
        {
            taskId: 'T-100-suffixed-policy',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                `${formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: true
                })}suffix`
        },
        {
            taskId: 'T-100-duplicate-policy-key',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":false,' +
                '"skip_low_findings":true,"forbid_child_tasks":true}`.'
        },
        {
            taskId: 'T-100-escaped-duplicate-policy-key',
            notes: `review_follow_up_fingerprint=${fingerprint}. ` +
                'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":false,' +
                '"\\u0073kip_low_findings":true,"forbid_child_tasks":true}`.'
        }
    ];

    for (const fixture of cases) {
        const content = taskQueueContent().replace(
            '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
            `| ${fixture.taskId} | TODO | P1 | review/follow-up | Invalid policy | codex | 2026-07-09 | strict | ${fixture.notes} |`
        );
        const policy = parseTaskQueueEntriesFromContent(content)
            .get(fixture.taskId)?.reviewFollowUpTaskClosurePolicy;

        assert.equal(policy?.valid, false, fixture.taskId);
        assert.equal(policy?.skip_low_findings, false, fixture.taskId);
        assert.equal(policy?.forbid_child_tasks, false, fixture.taskId);
        assert.ok((policy?.diagnostics.length || 0) > 0, fixture.taskId);
    }
});

test('readTaskQueueEntries returns an empty map for missing TASK.md by default', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-missing-'));
    try {
        assert.equal(readTaskQueueEntries(repoRoot).size, 0);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('readTaskQueueEntries can preserve callers that expect missing TASK.md to throw', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-throw-'));
    try {
        assert.throws(
            () => readTaskQueueEntries(repoRoot, { missingFile: 'throw' }),
            /TASK\.md/
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('readTaskQueueEntries reads TASK.md from the repo root', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-'));
    try {
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), taskQueueContent(), 'utf8');

        assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.title, 'Centralize helpers');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
