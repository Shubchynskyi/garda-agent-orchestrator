import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    scanProviderCompliance,
    formatProviderComplianceSummary,
    formatProviderComplianceDetail
} from '../../../src/validators/provider-compliance';

const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';

function writeFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function makeEntrypointContent(canonicalFile: string): string {
    return [
        MANAGED_START,
        `# ${canonicalFile}`,
        '',
        'This file is a redirect.',
        `Canonical source of truth: \`${canonicalFile}\`.`,
        '',
        'Hard stop: before any task execution, open `.agents/workflows/start-task.md`.',
        MANAGED_END
    ].join('\n');
}

function makeRouterContent(): string {
    return [
        MANAGED_START,
        '# Start Task',
        'This checklist is the shared start-task router.',
        MANAGED_END
    ].join('\n');
}

function makeBridgeContent(bridgePath: string): string {
    return [
        MANAGED_START,
        '# Provider Bridge',
        `Bridge path: \`${bridgePath}\`.`,
        'Hard stop: open `.agents/workflows/start-task.md`.',
        MANAGED_END
    ].join('\n');
}

test('scanProviderCompliance passes for well-formed workspace with router and entrypoints', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.equal(result.routerExists, true);
        assert.equal(result.passed, true);
        assert.equal(result.violations.length, 0);
        assert.equal(result.entrypoints.length, 1);
        assert.equal(result.entrypoints[0].file, 'AGENTS.md');
        assert.equal(result.entrypoints[0].referencesRouter, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance detects missing shared router', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.equal(result.routerExists, false);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((v) => v.includes('start-task router') && v.includes('missing')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance detects entrypoint missing router reference', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'CLAUDE.md'), [
            MANAGED_START,
            '# CLAUDE.md',
            'No router reference here.',
            MANAGED_END
        ].join('\n'));

        const result = scanProviderCompliance(tmpDir, ['CLAUDE.md']);
        assert.equal(result.routerExists, true);
        assert.equal(result.passed, false);
        const routerViolation = result.violations.find(
            (v) => v.includes('CLAUDE.md') && v.includes('start-task router')
        );
        assert.ok(routerViolation, 'Should report missing router reference');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance detects missing managed block markers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'),
            '# AGENTS.md\nManually edited content with .agents/workflows/start-task.md reference.\n'
        );

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        const ep = result.entrypoints.find((e) => e.file === 'AGENTS.md');
        assert.ok(ep);
        assert.equal(ep.hasManagedBlock, false);
        assert.ok(ep.violations.some((v) => v.includes('managed block')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance checks provider bridges for active entrypoints', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(
            path.join(tmpDir, '.github', 'copilot-instructions.md'),
            makeEntrypointContent('.github/copilot-instructions.md')
        );
        writeFile(
            path.join(tmpDir, '.github', 'agents', 'orchestrator.md'),
            makeBridgeContent('.github/agents/orchestrator.md')
        );

        const result = scanProviderCompliance(tmpDir, ['.github/copilot-instructions.md']);
        assert.equal(result.passed, true);
        const bridge = result.entrypoints.find((e) => e.kind === 'provider-bridge');
        assert.ok(bridge);
        assert.equal(bridge.exists, true);
        assert.equal(bridge.referencesRouter, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance skips non-active entrypoints', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.ok(!result.entrypoints.some((e) => e.file === 'CLAUDE.md'));
        assert.ok(!result.entrypoints.some((e) => e.file === 'GEMINI.md'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance detects Antigravity alias misalignment', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(
            path.join(tmpDir, '.antigravity', 'rules.md'),
            makeEntrypointContent('.antigravity/rules.md')
        );
        writeFile(
            path.join(tmpDir, '.antigravity', 'agents', 'orchestrator.md'),
            [
                MANAGED_START,
                '# Antigravity Agent: Orchestrator',
                'References .agents/workflows/start-task.md.',
                // Missing self bridge path reference
                MANAGED_END
            ].join('\n')
        );

        const result = scanProviderCompliance(tmpDir, ['.antigravity/rules.md']);
        assert.ok(
            result.violations.some((v) => v.includes('Antigravity') && v.includes('alias')),
            'Should flag Antigravity alias misalignment'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance scans handshake artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeFile(path.join(reviewsDir, 'T-100-handshake.json'), JSON.stringify({
            schema_version: 1,
            status: 'PASSED',
            provider: 'Codex',
            violations: []
        }));

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.equal(result.handshakeArtifacts.length, 1);
        assert.equal(result.handshakeArtifacts[0].taskId, 'T-100');
        assert.equal(result.handshakeArtifacts[0].status, 'PASSED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance reports failed handshake artifacts without poisoning passed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeFile(path.join(reviewsDir, 'T-200-handshake.json'), JSON.stringify({
            schema_version: 1,
            status: 'FAILED',
            provider: 'Claude',
            violations: ['CLI path mismatch.']
        }));

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.equal(result.handshakeArtifacts.length, 1);
        assert.equal(result.handshakeArtifacts[0].status, 'FAILED');
        // Historical handshake violations are informational only
        assert.equal(result.passed, true, 'Historical handshake failures must not poison workspace compliance');
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatProviderComplianceSummary produces compact output', () => {
    const result = {
        routerPath: '.agents/workflows/start-task.md',
        routerExists: true,
        entrypoints: [
            {
                file: 'AGENTS.md',
                kind: 'root-entrypoint' as const,
                exists: true,
                referencesRouter: true,
                routerReferenceMissing: null,
                hasManagedBlock: true,
                violations: []
            }
        ],
        handshakeArtifacts: [],
        violations: [],
        passed: true
    };

    const lines = formatProviderComplianceSummary(result);
    assert.ok(lines.some((l) => l.includes('Provider Control Compliance')));
    assert.ok(lines.some((l) => l.includes('[x]') && l.includes('Shared router')));
    assert.ok(lines.some((l) => l.includes('[x]') && l.includes('Entrypoint: AGENTS.md')));
});

test('formatProviderComplianceDetail produces detailed output with violations', () => {
    const result = {
        routerPath: '.agents/workflows/start-task.md',
        routerExists: false,
        entrypoints: [
            {
                file: 'CLAUDE.md',
                kind: 'root-entrypoint' as const,
                exists: true,
                referencesRouter: false,
                routerReferenceMissing: '.agents/workflows/start-task.md',
                hasManagedBlock: true,
                violations: ["CLAUDE.md does not reference the shared start-task router '.agents/workflows/start-task.md'."]
            }
        ],
        handshakeArtifacts: [],
        violations: [
            "Shared start-task router '.agents/workflows/start-task.md' is missing.",
            "CLAUDE.md does not reference the shared start-task router '.agents/workflows/start-task.md'."
        ],
        passed: false
    };

    const lines = formatProviderComplianceDetail(result);
    assert.ok(lines.some((l) => l.includes('MISSING')));
    assert.ok(lines.some((l) => l.includes('DRIFT_DETECTED')));
    assert.ok(lines.some((l) => l.includes('ViolationCount: 2')));
});

test('scanProviderCompliance detects missing active entrypoint file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        // CLAUDE.md is not created but is in active list

        const result = scanProviderCompliance(tmpDir, ['CLAUDE.md']);
        assert.equal(result.passed, false);
        const ep = result.entrypoints.find((e) => e.file === 'CLAUDE.md');
        assert.ok(ep);
        assert.equal(ep.exists, false);
        assert.ok(ep.violations.some((v) => v.includes('not materialized')));
        assert.ok(result.violations.some((v) => v.includes('CLAUDE.md') && v.includes('not materialized')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance detects missing handshake when task-mode exists (informational only)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeFile(path.join(reviewsDir, 'T-300-task-mode.json'), JSON.stringify({ task_id: 'T-300' }));
        // No T-300-handshake.json

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.ok(result.handshakeArtifacts.some(
            (a) => a.taskId === 'T-300' && a.status === 'MISSING'
        ));
        // Without activeTaskId, missing handshake is informational only
        assert.equal(result.passed, true);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance detects missing provider bridge for bridge-based provider', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(
            path.join(tmpDir, '.github', 'copilot-instructions.md'),
            makeEntrypointContent('.github/copilot-instructions.md')
        );
        // .github/agents/orchestrator.md NOT created

        const result = scanProviderCompliance(tmpDir, ['.github/copilot-instructions.md']);
        const bridge = result.entrypoints.find((e) => e.kind === 'provider-bridge');
        assert.ok(bridge);
        assert.equal(bridge.exists, false);
        assert.ok(bridge.violations.some((v) => v.includes('not materialized')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance reports unreadable handshake artifact as informational', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeFile(path.join(reviewsDir, 'T-400-handshake.json'), 'NOT VALID JSON {{{');

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        const artifact = result.handshakeArtifacts.find((a) => a.taskId === 'T-400');
        assert.ok(artifact);
        assert.equal(artifact.status, 'UNREADABLE');
        assert.ok(artifact.violations.some((v) => v.includes('unreadable')));
        // Without activeTaskId, unreadable handshake is informational only
        assert.equal(result.passed, true);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance handles multiple active entrypoints', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        writeFile(path.join(tmpDir, 'CLAUDE.md'), makeEntrypointContent('CLAUDE.md'));

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md', 'CLAUDE.md']);
        assert.equal(result.passed, true);
        const rootEntrypoints = result.entrypoints.filter((e) => e.kind === 'root-entrypoint');
        assert.equal(rootEntrypoints.length, 2);
        assert.ok(rootEntrypoints.every((ep) => ep.exists && ep.referencesRouter));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance with activeTaskId includes active task handshake violations in passed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeFile(path.join(reviewsDir, 'T-500-handshake.json'), JSON.stringify({
            schema_version: 1,
            status: 'FAILED',
            provider: 'Claude',
            violations: ['CLI path mismatch.']
        }));

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md'], { activeTaskId: 'T-500' });
        assert.equal(result.passed, false, 'Active task handshake failure should affect compliance');
        assert.ok(result.violations.some((v) => v.includes('CLI path mismatch')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance with activeTaskId ignores other tasks handshake violations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeFile(path.join(reviewsDir, 'T-OLD-handshake.json'), JSON.stringify({
            schema_version: 1,
            status: 'FAILED',
            provider: 'Codex',
            violations: ['Old provider drift.']
        }));
        writeFile(path.join(reviewsDir, 'T-CUR-handshake.json'), JSON.stringify({
            schema_version: 1,
            status: 'PASSED',
            provider: 'Claude',
            violations: []
        }));

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md'], { activeTaskId: 'T-CUR' });
        assert.equal(result.passed, true, 'Historical handshake failures must not affect compliance');
        assert.equal(result.handshakeArtifacts.length, 2, 'Both artifacts should still be listed');
        assert.ok(result.handshakeArtifacts.find((a) => a.taskId === 'T-OLD')?.status === 'FAILED');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance without activeTaskId treats all handshake violations as informational', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeFile(path.join(reviewsDir, 'T-A-handshake.json'), JSON.stringify({
            schema_version: 1, status: 'FAILED', provider: 'Claude', violations: ['fail A']
        }));
        writeFile(path.join(reviewsDir, 'T-B-task-mode.json'), JSON.stringify({ task_id: 'T-B' }));
        writeFile(path.join(reviewsDir, 'T-C-handshake.json'), 'CORRUPT');

        const result = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.equal(result.handshakeArtifacts.length, 3, 'All artifacts present for audit');
        assert.equal(result.passed, true, 'No handshake violations should affect passed');
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance normalizes provider aliases to canonical entrypoints', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), [
            MANAGED_START,
            '# AGENTS.md',
            'Missing router reference on purpose.',
            MANAGED_END
        ].join('\n'));

        const result = scanProviderCompliance(tmpDir, ['Codex']);
        assert.equal(result.passed, false, 'Codex alias must resolve to AGENTS.md and detect violations');
        assert.ok(result.entrypoints.some((entry) => entry.file === 'AGENTS.md'));
        assert.ok(result.violations.some((violation) => violation.includes('AGENTS.md') && violation.includes('start-task router')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance treats invalid active agent file tokens as compliance violations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());

        const result = scanProviderCompliance(tmpDir, ['unknown-provider']);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((violation) => violation.includes("ActiveAgentFiles token 'unknown-provider' is invalid")));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanProviderCompliance uses reviews index for handshake scanning without writing index', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-test-'));
    try {
        writeFile(path.join(tmpDir, '.agents', 'workflows', 'start-task.md'), makeRouterContent());
        writeFile(path.join(tmpDir, 'AGENTS.md'), makeEntrypointContent('AGENTS.md'));
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeFile(path.join(reviewsDir, 'T-IDX-handshake.json'), JSON.stringify({
            schema_version: 1,
            status: 'PASSED',
            provider: 'Codex',
            violations: []
        }));
        writeFile(path.join(reviewsDir, 'T-IDX-task-mode.json'), JSON.stringify({ task_id: 'T-IDX' }));

        // Compliance scan is read-only — must not create the index file
        const result1 = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.equal(result1.handshakeArtifacts.length, 1);
        assert.equal(result1.handshakeArtifacts[0].taskId, 'T-IDX');
        assert.equal(result1.handshakeArtifacts[0].status, 'PASSED');

        // Index should NOT be created by a read-only compliance scan
        const indexPath = path.join(reviewsDir, 'reviews-index.json');
        assert.equal(fs.existsSync(indexPath), false, 'Compliance scan must not write reviews index');

        // Second call still works (rebuilds in-memory each time)
        const result2 = scanProviderCompliance(tmpDir, ['AGENTS.md']);
        assert.equal(result2.handshakeArtifacts.length, 1);
        assert.equal(result2.passed, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
