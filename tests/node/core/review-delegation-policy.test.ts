import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    GARDA_NO_DELEGATE_ENV,
    resolveReviewDelegationPolicy
} from '../../../src/core/review-delegation-policy';

function createRepoRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-review-delegation-policy-'));
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

test('review delegation policy enables no-delegate mode from GARDA_NO_DELEGATE', () => {
    const repoRoot = createRepoRoot();
    try {
        const result = resolveReviewDelegationPolicy({
            repoRoot,
            env: { [GARDA_NO_DELEGATE_ENV]: '1' } as NodeJS.ProcessEnv
        });

        assert.equal(result.active, true);
        assert.equal(result.source, 'env');
        assert.match(result.reason || '', /GARDA_NO_DELEGATE is active/);
        assert.match(result.remediation || '', /Unset GARDA_NO_DELEGATE/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review delegation policy enables no-delegate mode from workflow config', () => {
    const repoRoot = createRepoRoot();
    try {
        writeWorkflowConfig(repoRoot, {
            review_delegation: {
                no_delegate: true
            }
        });

        const result = resolveReviewDelegationPolicy({
            repoRoot,
            env: {} as NodeJS.ProcessEnv
        });

        assert.equal(result.active, true);
        assert.equal(result.source, 'config');
        assert.match(result.reason || '', /review_delegation\.no_delegate is true/);
        assert.match(result.remediation || '', /audited workflow configuration path/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review delegation policy remains inactive when env and config are off', () => {
    const repoRoot = createRepoRoot();
    try {
        writeWorkflowConfig(repoRoot, {
            review_delegation: {
                no_delegate: false
            }
        });

        const result = resolveReviewDelegationPolicy({
            repoRoot,
            env: { [GARDA_NO_DELEGATE_ENV]: 'false' } as NodeJS.ProcessEnv
        });

        assert.equal(result.active, false);
        assert.equal(result.source, 'none');
        assert.equal(result.reason, null);
        assert.equal(result.remediation, null);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review delegation policy treats boolean-like workflow config no-delegate as active', () => {
    const repoRoot = createRepoRoot();
    try {
        writeWorkflowConfig(repoRoot, {
            review_delegation: {
                no_delegate: 'yes'
            }
        });

        const result = resolveReviewDelegationPolicy({
            repoRoot,
            env: {} as NodeJS.ProcessEnv
        });

        assert.equal(result.active, true);
        assert.equal(result.source, 'config');
        assert.match(result.reason || '', /review_delegation\.no_delegate is true/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review delegation policy fails closed when workflow config is malformed JSON', () => {
    const repoRoot = createRepoRoot();
    try {
        writeRawWorkflowConfig(repoRoot, '{ invalid json');

        const result = resolveReviewDelegationPolicy({
            repoRoot,
            env: {} as NodeJS.ProcessEnv
        });

        assert.equal(result.active, true);
        assert.equal(result.source, 'config');
        assert.match(result.reason || '', /unavailable or invalid/);
        assert.match(result.reason || '', /could not be parsed/);
        assert.match(result.remediation || '', /Repair workflow-config\.json/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review delegation policy fails closed when workflow config is not an object', () => {
    const repoRoot = createRepoRoot();
    try {
        writeRawWorkflowConfig(repoRoot, '[]');

        const result = resolveReviewDelegationPolicy({
            repoRoot,
            env: {} as NodeJS.ProcessEnv
        });

        assert.equal(result.active, true);
        assert.equal(result.source, 'config');
        assert.match(result.reason || '', /must be a JSON object/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review delegation policy fails closed when no-delegate config is invalid', () => {
    const repoRoot = createRepoRoot();
    try {
        writeWorkflowConfig(repoRoot, {
            review_delegation: {
                no_delegate: 'maybe'
            }
        });

        const result = resolveReviewDelegationPolicy({
            repoRoot,
            env: {} as NodeJS.ProcessEnv
        });

        assert.equal(result.active, true);
        assert.equal(result.source, 'config');
        assert.match(result.reason || '', /no_delegate must be boolean-like/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review delegation policy fails closed when review delegation key has wrong casing', () => {
    const repoRoot = createRepoRoot();
    try {
        writeWorkflowConfig(repoRoot, {
            Review_Delegation: {
                no_delegate: true
            }
        });

        const result = resolveReviewDelegationPolicy({
            repoRoot,
            env: {} as NodeJS.ProcessEnv
        });

        assert.equal(result.active, true);
        assert.equal(result.source, 'config');
        assert.match(result.reason || '', /Review_Delegation must use canonical key review_delegation/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
