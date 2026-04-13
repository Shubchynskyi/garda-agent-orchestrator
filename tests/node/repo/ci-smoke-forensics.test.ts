import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

interface WorkflowStep {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    with?: Record<string, unknown>;
    shell?: string;
    run?: string;
}

interface WorkflowJob {
    name?: string;
    steps?: WorkflowStep[];
    strategy?: { matrix?: { os?: string[] } };
}

interface WorkflowFile {
    jobs?: Record<string, WorkflowJob>;
}

function loadCiWorkflow(): WorkflowFile {
    const repoRoot = getRepoRoot();
    const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
    assert.ok(fs.existsSync(ciPath), `CI workflow must exist at ${ciPath}`);
    const content = fs.readFileSync(ciPath, 'utf8');
    // Lightweight YAML parsing: extract only what we need via line scanning.
    // Full yaml parsing would require a dependency; line-level checks are
    // sufficient for structural contract validation.
    return { _raw: content } as unknown as WorkflowFile & { _raw: string };
}

function getRawContent(workflow: WorkflowFile): string {
    return (workflow as unknown as { _raw: string })._raw;
}

test('CI workflow smoke job exists', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(raw, /^\s+smoke:/m, 'CI workflow must define a smoke job');
});

test('smoke job lifecycle step has an id for output forwarding', () => {
    const raw = getRawContent(loadCiWorkflow());
    // The lifecycle step must have `id: lifecycle-smoke` so the forensics
    // collection step can reference its outputs.
    assert.match(
        raw,
        /id:\s*lifecycle-smoke/,
        'Lifecycle smoke step must have id: lifecycle-smoke'
    );
});

test('smoke job lifecycle step exports smoke_dir to GITHUB_OUTPUT', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /smoke_dir=.*>>\s*.*GITHUB_OUTPUT/,
        'Lifecycle smoke step must export smoke_dir to $GITHUB_OUTPUT'
    );
});

test('smoke job has failure-conditional evidence collection step', () => {
    const raw = getRawContent(loadCiWorkflow());
    // Must have a step that creates the smoke-failure-evidence directory
    assert.match(
        raw,
        /name:\s*Collect smoke failure evidence/,
        'Smoke job must have a "Collect smoke failure evidence" step'
    );
    // The collection step must run on failure only
    assert.match(
        raw,
        /if:\s*failure\(\)/,
        'Evidence collection step must use if: failure() condition'
    );
});

test('smoke job has failure-conditional artifact upload step', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /name:\s*Upload smoke failure evidence/,
        'Smoke job must have an "Upload smoke failure evidence" step'
    );
    assert.match(
        raw,
        /uses:\s*actions\/upload-artifact@v4/,
        'Upload step must use actions/upload-artifact@v4'
    );
});

test('evidence collection captures npm debug logs', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /\.npm\/_logs/,
        'Evidence collection must capture npm debug logs from ~/.npm/_logs/'
    );
});

test('evidence collection captures orchestrator runtime state', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /garda-agent-orchestrator\/runtime/,
        'Evidence collection must capture orchestrator runtime artifacts'
    );
});

test('evidence collection captures runner environment snapshot', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /runner-env\.txt/,
        'Evidence collection must produce a runner-env.txt snapshot'
    );
});

test('upload artifact uses per-OS naming', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /smoke-failure-evidence-\$\{\{\s*matrix\.os\s*\}\}/,
        'Artifact name must include matrix.os for per-platform disambiguation'
    );
});

test('upload artifact has bounded retention', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /retention-days:\s*\d+/,
        'Upload artifact must specify retention-days to bound storage cost'
    );
});
