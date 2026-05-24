import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    seedRuleFiles
} from './cli/commands/gate-test-repo-bootstrap';
import {
    prepareReviewDiffFixture,
    seedInitAnswers,
    seedReusableReviewEvidence,
    writeCleanReviewArtifact,
    writeCompilePassEvidence,
    writePreflight
} from './cli/commands/gate-test-seed-helpers';

export {
    getOrchestratorRoot,
    getReviewsRoot
};

export const DEFAULT_GATE_FIXTURE_TASK_ID = 'T-gate-fixture';
export const DEFAULT_OPERATOR_CONFIRMED_AT_UTC = '2026-01-01T00:00:00.000Z';

export interface CanonicalTaskRowOptions {
    taskId: string;
    status?: string;
    priority?: string;
    area?: string;
    title?: string;
    owner?: string;
    updated?: string;
    profile?: string;
    notes?: string;
}

export interface GateFixtureOptions extends Partial<CanonicalTaskRowOptions> {
    sourceOfTruth?: string;
}

export interface GateFixture {
    repoRoot: string;
    orchestratorRoot: string;
    reviewsRoot: string;
    taskId: string;
    cleanup(): void;
}

function normalizeTaskCell(value: string): string {
    return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

export function buildCanonicalTaskRow(options: CanonicalTaskRowOptions): string {
    return [
        '',
        normalizeTaskCell(options.taskId),
        normalizeTaskCell(options.status || '🟦 TODO'),
        normalizeTaskCell(options.priority || 'P1'),
        normalizeTaskCell(options.area || 'test/gate-fixture'),
        normalizeTaskCell(options.title || 'Gate fixture task'),
        normalizeTaskCell(options.owner || 'gpt-5.3-codex'),
        normalizeTaskCell(options.updated || '2026-05-24'),
        normalizeTaskCell(options.profile || 'balanced'),
        normalizeTaskCell(options.notes || 'fixture'),
        ''
    ].join(' | ');
}

export function writeCanonicalTaskQueue(repoRoot: string, options: CanonicalTaskRowOptions): string {
    const taskPath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(taskPath, [
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        buildCanonicalTaskRow(options)
    ].join('\n') + '\n', 'utf8');
    return taskPath;
}

export function createGateFixture(options: GateFixtureOptions = {}): GateFixture {
    const repoRoot = createTempRepo();
    const taskId = options.taskId || DEFAULT_GATE_FIXTURE_TASK_ID;
    seedRuleFiles(repoRoot);
    writeCanonicalTaskQueue(repoRoot, {
        taskId,
        status: options.status,
        priority: options.priority,
        area: options.area,
        title: options.title,
        owner: options.owner,
        updated: options.updated,
        profile: options.profile,
        notes: options.notes
    });
    seedInitAnswers(repoRoot, options.sourceOfTruth || 'Codex');

    return {
        repoRoot,
        orchestratorRoot: getOrchestratorRoot(repoRoot),
        reviewsRoot: getReviewsRoot(repoRoot),
        taskId,
        cleanup() {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    };
}

export function writeGateFixturePreflight(
    fixture: GateFixture,
    overrides: Record<string, unknown> = {},
    outputFileName?: string
): string {
    return writePreflight(fixture.repoRoot, fixture.taskId, overrides, outputFileName);
}

export function prepareGateFixtureReviewDiff(fixture: GateFixture, preflightPath: string): void {
    prepareReviewDiffFixture(fixture.repoRoot, preflightPath);
}

export function writeGateFixtureCompilePass(fixture: GateFixture, preflightPath: string): void {
    writeCompilePassEvidence(fixture.repoRoot, fixture.taskId, preflightPath);
}

export function writeGateFixtureReviewReceipt(
    fixture: GateFixture,
    reviewKey: string,
    verdict: string
): void {
    writeCleanReviewArtifact(fixture.repoRoot, fixture.taskId, reviewKey, verdict);
}

export function seedGateFixtureReusableReview(
    fixture: GateFixture,
    reviewKey: string,
    verdict: string,
    preflightPath: string,
    reviewContextPath: string,
    reviewerIdentity?: string
): string {
    return seedReusableReviewEvidence(
        fixture.repoRoot,
        fixture.taskId,
        reviewKey,
        verdict,
        preflightPath,
        reviewContextPath,
        reviewerIdentity
    );
}

export function gateFixtureOperatorConfirmationArgs(
    confirmedAtUtc = DEFAULT_OPERATOR_CONFIRMED_AT_UTC
): string[] {
    return [
        '--operator-confirmed',
        'yes',
        '--operator-confirmed-at-utc',
        confirmedAtUtc
    ];
}
