import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    GATE_CHAIN_MANIFEST,
    buildGateChainRemediationCommand,
    evaluateDependentValidationChain,
    getGateChainEdgesForConsumer,
    getGateChainEdgesForProducer
} from '../../../src/core/dependent-validation-chains';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function agePath(filePath: string, ageMs: number): void {
    const agedDate = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, agedDate, agedDate);
}

function createValidationChainFixture(): {
    root: string;
    consumerPath: string;
    manifestPath: string;
    sourcePath: string;
    lockPath: string;
    nestedCwd: string;
    cleanup: () => void;
} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-validation-chain-'));
    const sourcePath = path.join(root, 'src', 'feature.ts');
    const consumerPath = path.join(root, '.node-build', 'tests', 'node', 'sample.test.js');
    const manifestPath = path.join(root, '.node-build', 'node-foundation-manifest.json');
    const lockPath = path.join(root, '.node-build.lock');
    const nestedCwd = path.join(root, 'packages', 'feature');

    writeFile(sourcePath, 'export const feature = true;\n');
    writeFile(path.join(root, 'tests', 'node', 'sample.test.ts'), 'void 0;\n');
    writeFile(path.join(root, 'scripts', 'node-foundation', 'helper.ts'), 'void 0;\n');
    writeFile(consumerPath, 'import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest("sample", () => { assert.equal(1, 1); });\n');
    fs.mkdirSync(nestedCwd, { recursive: true });

    return {
        root,
        consumerPath,
        manifestPath,
        sourcePath,
        lockPath,
        nestedCwd,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

function writeNodeFoundationManifest(
    manifestPath: string,
    sourceRoots: string[] = ['src', 'tests/node', 'scripts/node-foundation']
): void {
    writeFile(manifestPath, JSON.stringify({
        sourceRoots,
        files: ['tests/node/sample.test.js']
    }, null, 2) + '\n');
}

test('evaluateDependentValidationChain returns NOT_APPLICABLE for non-consumer commands', () => {
    const fixture = createValidationChainFixture();
    try {
        const result = evaluateDependentValidationChain(['npm', 'test'], fixture.root);
        assert.equal(result.matched, false);
        assert.equal(result.status, 'NOT_APPLICABLE');
    } finally {
        fixture.cleanup();
    }
});

test('evaluateDependentValidationChain reports missing producer manifest for direct .node-build consumers', () => {
    const fixture = createValidationChainFixture();
    try {
        const result = evaluateDependentValidationChain(['node', '--test', fixture.consumerPath], fixture.root);
        assert.equal(result.matched, true);
        assert.equal(result.status, 'MISSING_PRODUCER');
        assert.match(result.message || '', /npm run build:node-foundation/);
    } finally {
        fixture.cleanup();
    }
});

test('evaluateDependentValidationChain still matches direct .node-build consumers from a nested cwd', () => {
    const fixture = createValidationChainFixture();
    try {
        const nestedConsumerPath = path.relative(fixture.nestedCwd, fixture.consumerPath);
        const result = evaluateDependentValidationChain(['node', '--test', nestedConsumerPath], fixture.nestedCwd);
        assert.equal(result.matched, true);
        assert.equal(result.status, 'MISSING_PRODUCER');
        assert.match(result.message || '', /\.node-build/);
    } finally {
        fixture.cleanup();
    }
});

test('evaluateDependentValidationChain reports stale producer output when sources are newer than manifest', () => {
    const fixture = createValidationChainFixture();
    try {
        writeNodeFoundationManifest(fixture.manifestPath);
        agePath(fixture.manifestPath, 10_000);
        writeFile(fixture.sourcePath, 'export const feature = false;\n');

        const result = evaluateDependentValidationChain(['node', '--test', fixture.consumerPath], fixture.root);
        assert.equal(result.matched, true);
        assert.equal(result.status, 'STALE_PRODUCER');
        assert.match(result.message || '', /older than the latest source input/i);
    } finally {
        fixture.cleanup();
    }
});

test('evaluateDependentValidationChain blocks manifests whose declared source roots do not exist', () => {
    const fixture = createValidationChainFixture();
    try {
        writeNodeFoundationManifest(fixture.manifestPath, ['missing-src', 'missing-tests']);

        const result = evaluateDependentValidationChain(['node', '--test', fixture.consumerPath], fixture.root);
        assert.equal(result.matched, true);
        assert.equal(result.status, 'MISSING_PRODUCER');
        assert.match(result.message || '', /source roots/i);
    } finally {
        fixture.cleanup();
    }
});

test('evaluateDependentValidationChain blocks manifests whose declared source roots exist but are empty', () => {
    const fixture = createValidationChainFixture();
    try {
        fs.mkdirSync(path.join(fixture.root, 'empty-src'), { recursive: true });
        fs.mkdirSync(path.join(fixture.root, 'empty-tests'), { recursive: true });
        writeNodeFoundationManifest(fixture.manifestPath, ['empty-src', 'empty-tests']);

        const result = evaluateDependentValidationChain(['node', '--test', fixture.consumerPath], fixture.root);
        assert.equal(result.matched, true);
        assert.equal(result.status, 'MISSING_PRODUCER');
        assert.match(result.message || '', /empty source roots/i);
    } finally {
        fixture.cleanup();
    }
});

test('evaluateDependentValidationChain reports active producer lock for direct .node-build consumers', () => {
    const fixture = createValidationChainFixture();
    try {
        agePath(fixture.sourcePath, 10_000);
        writeNodeFoundationManifest(fixture.manifestPath);
        fs.mkdirSync(fixture.lockPath, { recursive: true });
        writeFile(path.join(fixture.lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAtUtc: new Date().toISOString()
        }, null, 2) + '\n');

        const result = evaluateDependentValidationChain(['node', '--test', fixture.consumerPath], fixture.root);
        assert.equal(result.matched, true);
        assert.equal(result.status, 'PRODUCER_ACTIVE');
        assert.match(result.message || '', /producer lock/i);
    } finally {
        fixture.cleanup();
    }
});

test('evaluateDependentValidationChain returns READY when manifest is fresh and no producer lock is active', () => {
    const fixture = createValidationChainFixture();
    try {
        agePath(fixture.sourcePath, 10_000);
        writeNodeFoundationManifest(fixture.manifestPath);

        const result = evaluateDependentValidationChain(['node', '--test', fixture.consumerPath], fixture.root);
        assert.equal(result.matched, true);
        assert.equal(result.status, 'READY');
        assert.equal(result.message, null);
    } finally {
        fixture.cleanup();
    }
});

test('GATE_CHAIN_MANIFEST declares same-task startup and preflight compile chains', () => {
    assert.ok(GATE_CHAIN_MANIFEST.some((edge) => edge.id === 'task-entry-rules-to-handshake'));
    assert.ok(GATE_CHAIN_MANIFEST.some((edge) => edge.id === 'handshake-to-shell-smoke'));
    assert.ok(GATE_CHAIN_MANIFEST.some((edge) => edge.id === 'preflight-to-post-preflight-rules'));
    assert.ok(GATE_CHAIN_MANIFEST.some((edge) => edge.id === 'post-preflight-rules-to-compile'));
    assert.equal(Object.isFrozen(GATE_CHAIN_MANIFEST), true);

    for (const edge of GATE_CHAIN_MANIFEST) {
        assert.equal(Object.isFrozen(edge), true);
        assert.equal(edge.same_task, true);
        assert.equal(edge.same_cycle, true);
        assert.ok(edge.producer_gate);
        assert.ok(edge.producer_event);
        assert.ok(edge.consumer_gate);
        assert.ok(edge.consumer_event);
        assert.ok(edge.missing_remediation_command.startsWith('{cli} gate '));
    }
});

test('GATE_CHAIN_MANIFEST keeps review lifecycle edges scoped to review-type lanes', () => {
    const reviewEdges = GATE_CHAIN_MANIFEST.filter((edge) => edge.consumer_gate.includes('review') || edge.producer_gate.includes('review'));
    assert.ok(reviewEdges.some((edge) => edge.id === 'review-context-to-routing'));
    assert.ok(reviewEdges.some((edge) => edge.id === 'review-result-to-receipt'));
    assert.ok(reviewEdges.every((edge) => edge.lane_scope === 'review_type'));

    const taskEdges = GATE_CHAIN_MANIFEST.filter((edge) => edge.lane_scope === 'task');
    assert.ok(taskEdges.every((edge) => !edge.consumer_gate.startsWith('record-review')));
});

test('getGateChainEdgesForConsumer and getGateChainEdgesForProducer resolve declarative edges', () => {
    const compileEdges = getGateChainEdgesForConsumer('compile-gate');
    assert.deepEqual(compileEdges.map((edge) => edge.id), ['post-preflight-rules-to-compile']);
    assert.notEqual(compileEdges[0], GATE_CHAIN_MANIFEST.find((edge) => edge.id === 'post-preflight-rules-to-compile'));

    const preflightProducerEdges = getGateChainEdgesForProducer('classify-change');
    assert.deepEqual(preflightProducerEdges.map((edge) => edge.id), ['preflight-to-post-preflight-rules']);

    const missingEdges = getGateChainEdgesForConsumer('unknown-gate');
    assert.deepEqual(missingEdges, []);
});

test('buildGateChainRemediationCommand renders task and review placeholders', () => {
    const compileEdge = getGateChainEdgesForConsumer('compile-gate')[0];
    assert.equal(
        buildGateChainRemediationCommand(compileEdge, {
            taskId: 'T-332',
            preflightPath: 'garda-agent-orchestrator/runtime/reviews/T-332-preflight.json',
            cliPrefix: 'node bin/garda.js',
            repoRoot: '.'
        }),
        'node bin/garda.js gate load-rule-pack --task-id "T-332" --stage "POST_PREFLIGHT" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-332-preflight.json" --repo-root "."'
    );

    const routingEdge = getGateChainEdgesForConsumer('record-review-routing')[0];
    assert.equal(
        buildGateChainRemediationCommand(routingEdge, {
            taskId: 'T-334',
            reviewType: 'security',
            preflightPath: 'garda-agent-orchestrator/runtime/reviews/T-334-preflight.json',
            depth: 2
        }),
        'node bin/garda.js gate build-review-context --review-type "security" --depth "2" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-334-preflight.json" --repo-root "."'
    );
});
