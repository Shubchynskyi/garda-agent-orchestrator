import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GARDA_NO_DELEGATE_ENV } from '../../../../src/core/review-delegation-policy';
import { resolveRuntimeReviewerIdentity } from '../../../../src/gates/review/reviewer-routing';

function createRepoRoot(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-reviewer-routing-no-delegate-'));
    const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(
        path.join(runtimeRoot, 'init-answers.json'),
        JSON.stringify({ SourceOfTruth: 'Codex' }, null, 2),
        'utf8'
    );
    return repoRoot;
}

function writeWorkflowConfig(repoRoot: string, workflowConfig: Record<string, unknown>): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(workflowConfig, null, 2), 'utf8');
}

function writeRawWorkflowConfig(repoRoot: string, contents: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, contents, 'utf8');
}

function withEnvVar(name: string, value: string, run: () => void): void {
    const previous = process.env[name];
    process.env[name] = value;
    try {
        run();
    } finally {
        if (previous === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = previous;
        }
    }
}

test('runtime reviewer identity blocks launchability when GARDA_NO_DELEGATE is active', () => {
    const repoRoot = createRepoRoot();
    try {
        withEnvVar(GARDA_NO_DELEGATE_ENV, '1', () => {
            const identity = resolveRuntimeReviewerIdentity({
                repoRoot,
                executionProvider: 'Codex',
                allowLegacyFallback: false
            });

            assert.equal(identity.identity_status, 'resolved');
            assert.equal(identity.reviewer_subagent_launch_status, 'blocked');
            assert.equal(identity.no_delegate_mode.active, true);
            assert.equal(identity.no_delegate_mode.source, 'env');
            assert.match(identity.reviewer_subagent_launch_reason, /GARDA_NO_DELEGATE is active/);
        });
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('runtime reviewer identity blocks launchability when workflow config no-delegate is active', () => {
    const repoRoot = createRepoRoot();
    try {
        writeWorkflowConfig(repoRoot, {
            review_delegation: {
                no_delegate: true
            }
        });

        const identity = resolveRuntimeReviewerIdentity({
            repoRoot,
            executionProvider: 'Codex',
            allowLegacyFallback: false
        });

        assert.equal(identity.identity_status, 'resolved');
        assert.equal(identity.reviewer_subagent_launch_status, 'blocked');
        assert.equal(identity.no_delegate_mode.active, true);
        assert.equal(identity.no_delegate_mode.source, 'config');
        assert.match(identity.reviewer_subagent_launch_reason, /review_delegation\.no_delegate is true/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('runtime reviewer identity fails closed when workflow config no-delegate policy is invalid', () => {
    const repoRoot = createRepoRoot();
    try {
        writeRawWorkflowConfig(repoRoot, '{ invalid json');

        const identity = resolveRuntimeReviewerIdentity({
            repoRoot,
            executionProvider: 'Codex',
            allowLegacyFallback: false
        });

        assert.equal(identity.identity_status, 'resolved');
        assert.equal(identity.reviewer_subagent_launch_status, 'blocked');
        assert.equal(identity.no_delegate_mode.active, true);
        assert.equal(identity.no_delegate_mode.source, 'config');
        assert.match(identity.reviewer_subagent_launch_reason, /unavailable or invalid/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
