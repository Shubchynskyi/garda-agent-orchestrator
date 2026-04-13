/**
 * Golden snapshot tests for completion gate and compile-gate behavior.
 *
 * These tests lock down the deterministic output shapes of gate functions
 * including stage sequence validation, compile command classification,
 * and completion evidence structures.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    STAGE_SEQUENCE_ORDER,
    collectOrderedTimelineEvents,
    validateStageSequence,
    type TimelineEventEntry,
    type StageSequenceEvidence
} from '../../../src/gates/completion';

import {
    getCompileCommandProfile,
    getCompileCommands
} from '../../../src/gates/compile-gate';

import {
    getCompileFailureStrategyConfig
} from '../../../src/gate-runtime/output-filters';

// ============================================================================
// STAGE_SEQUENCE_ORDER — golden constant
// ============================================================================

describe('golden: STAGE_SEQUENCE_ORDER', () => {
    it('has exact canonical ordering', () => {
        assert.deepEqual([...STAGE_SEQUENCE_ORDER], [
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'PREFLIGHT_CLASSIFIED',
            'IMPLEMENTATION_STARTED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_RECORDED',
            'REVIEW_GATE_PASSED'
        ]);
    });

    it('is frozen and immutable', () => {
        assert.ok(Object.isFrozen(STAGE_SEQUENCE_ORDER));
    });
});

// ============================================================================
// collectOrderedTimelineEvents — golden JSONL parsing
// ============================================================================

describe('golden: collectOrderedTimelineEvents', () => {
    function writeTempJsonl(lines: string[]): { filePath: string; dir: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-timeline-'));
        const filePath = path.join(dir, 'T-TEST.jsonl');
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
        return { filePath, dir };
    }

    it('parses well-formed JSONL into ordered entries', () => {
        const lines = [
            JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00Z', details: { task_id: 'T-001' } }),
            JSON.stringify({ event_type: 'RULE_PACK_LOADED', timestamp_utc: '2026-01-01T00:00:01Z', details: { stage: 'TASK_ENTRY' } }),
            JSON.stringify({ event_type: 'PREFLIGHT_CLASSIFIED', timestamp_utc: '2026-01-01T00:00:02Z', details: null })
        ];
        const { filePath, dir } = writeTempJsonl(lines);
        try {
            const errors: string[] = [];
            const events = collectOrderedTimelineEvents(filePath, errors);

            assert.equal(errors.length, 0);
            assert.equal(events.length, 3);

            assert.equal(events[0].event_type, 'TASK_MODE_ENTERED');
            assert.equal(events[0].sequence, 0);
            assert.deepEqual(events[0].details, { task_id: 'T-001' });

            assert.equal(events[1].event_type, 'RULE_PACK_LOADED');
            assert.equal(events[1].sequence, 1);

            assert.equal(events[2].event_type, 'PREFLIGHT_CLASSIFIED');
            assert.equal(events[2].sequence, 2);
            assert.equal(events[2].details, null);

            // Entry shape contract
            for (const entry of events) {
                assert.deepEqual(Object.keys(entry).sort(), [
                    'details', 'event_type', 'sequence', 'timestamp_utc'
                ]);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports errors for invalid JSON lines', () => {
        const lines = [
            JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-01-01T00:00:00Z' }),
            'this is not json',
            JSON.stringify({ event_type: 'COMPILE_GATE_PASSED', timestamp_utc: '2026-01-01T00:00:02Z' })
        ];
        const { filePath, dir } = writeTempJsonl(lines);
        try {
            const errors: string[] = [];
            const events = collectOrderedTimelineEvents(filePath, errors);

            assert.equal(events.length, 2);
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('invalid JSON line'));

            // Sequences skip the broken line
            assert.equal(events[0].sequence, 0);
            assert.equal(events[1].sequence, 2);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports error for missing file', () => {
        const errors: string[] = [];
        const events = collectOrderedTimelineEvents('/nonexistent/path.jsonl', errors);

        assert.equal(events.length, 0);
        assert.equal(errors.length, 1);
        assert.ok(errors[0].includes('Task timeline not found'));
    });

    it('handles empty file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-empty-'));
        const filePath = path.join(dir, 'empty.jsonl');
        fs.writeFileSync(filePath, '', 'utf8');
        try {
            const errors: string[] = [];
            const events = collectOrderedTimelineEvents(filePath, errors);
            assert.equal(events.length, 0);
            assert.equal(errors.length, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// validateStageSequence — golden evidence shapes
// ============================================================================

describe('golden: validateStageSequence', () => {
    function makeEvents(types: string[]): TimelineEventEntry[] {
        return types.map((event_type, index) => ({
            event_type,
            timestamp_utc: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
            sequence: index,
            details: null
        }));
    }

    it('valid code-changing sequence produces zero violations', () => {
        const events = makeEvents([
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'PREFLIGHT_CLASSIFIED',
            'IMPLEMENTATION_STARTED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_RECORDED',
            'REVIEW_GATE_PASSED'
        ]);
        const evidence = validateStageSequence(events, true, 'timeline.jsonl');

        assert.deepEqual(Object.keys(evidence).sort(), [
            'code_changed',
            'expected_order',
            'observed_order',
            'review_artifact_keys',
            'review_skill_ids',
            'review_skill_reference_paths',
            'reviewer_execution_modes',
            'violations'
        ]);

        assert.equal(evidence.code_changed, true);
        assert.deepEqual(evidence.violations, []);
        assert.deepEqual(evidence.observed_order, [...STAGE_SEQUENCE_ORDER]);
    });

    it('out-of-order stages produce violations', () => {
        const events = makeEvents([
            'TASK_MODE_ENTERED',
            'COMPILE_GATE_PASSED',
            'RULE_PACK_LOADED',
            'PREFLIGHT_CLASSIFIED',
            'IMPLEMENTATION_STARTED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_GATE_PASSED'
        ]);
        const evidence = validateStageSequence(events, true, 'timeline.jsonl');

        assert.ok(evidence.violations.length > 0, 'must report at least one violation');
        assert.ok(evidence.violations.some(v => v.includes('Stage sequence violation')));
        assert.ok(evidence.violations.some(v => v.includes('RULE_PACK_LOADED')));
    });

    it('non-code-changing task uses minimal expected order', () => {
        const events = makeEvents([
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_GATE_PASSED'
        ]);
        const evidence = validateStageSequence(events, false, 'timeline.jsonl');

        assert.equal(evidence.code_changed, false);
        assert.deepEqual(evidence.violations, []);
        assert.deepEqual(evidence.expected_order, [
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_GATE_PASSED'
        ]);
    });

    it('missing PREFLIGHT_CLASSIFIED for code-changing task triggers violation', () => {
        const events = makeEvents([
            'TASK_MODE_ENTERED',
            'RULE_PACK_LOADED',
            'IMPLEMENTATION_STARTED',
            'COMPILE_GATE_PASSED',
            'REVIEW_PHASE_STARTED',
            'REVIEW_GATE_PASSED'
        ]);
        const evidence = validateStageSequence(events, true, 'timeline.jsonl');
        assert.ok(evidence.violations.some(v => v.includes('PREFLIGHT_CLASSIFIED')));
    });
});

// ============================================================================
// getCompileCommandProfile — golden classification matrix
// ============================================================================

describe('golden: getCompileCommandProfile', () => {
    const testCases: Array<{ command: string; kind: string; strategy: string; label: string; failure_profile: string; success_profile: string }> = [
        // Node build tools
        { command: 'npm run build', kind: 'compile', strategy: 'node', label: 'node-build', failure_profile: 'compile_failure_console_node', success_profile: 'compile_success_console' },
        { command: 'yarn build', kind: 'compile', strategy: 'node', label: 'node-build', failure_profile: 'compile_failure_console_node', success_profile: 'compile_success_console' },
        { command: 'pnpm run build', kind: 'compile', strategy: 'node', label: 'node-build', failure_profile: 'compile_failure_console_node', success_profile: 'compile_success_console' },
        { command: 'vite build', kind: 'compile', strategy: 'node', label: 'node-build', failure_profile: 'compile_failure_console_node', success_profile: 'compile_success_console' },
        // Java build tools
        { command: 'mvn clean install', kind: 'compile', strategy: 'maven', label: 'maven', failure_profile: 'compile_failure_console_maven', success_profile: 'compile_success_console' },
        { command: './gradlew build', kind: 'compile', strategy: 'gradle', label: 'gradle', failure_profile: 'compile_failure_console_gradle', success_profile: 'compile_success_console' },
        // Rust
        { command: 'cargo build --release', kind: 'compile', strategy: 'cargo', label: 'cargo', failure_profile: 'compile_failure_console_cargo', success_profile: 'compile_success_console' },
        // .NET
        { command: 'dotnet build', kind: 'compile', strategy: 'dotnet', label: 'dotnet', failure_profile: 'compile_failure_console_dotnet', success_profile: 'compile_success_console' },
        // Go
        { command: 'go build ./...', kind: 'compile', strategy: 'go', label: 'go', failure_profile: 'compile_failure_console_go', success_profile: 'compile_success_console' },
        // Test commands
        { command: 'npm test', kind: 'test', strategy: 'test', label: 'test', failure_profile: 'test_failure_console', success_profile: 'test_success_console' },
        { command: 'npm run test:ci', kind: 'test', strategy: 'test', label: 'test', failure_profile: 'test_failure_console', success_profile: 'test_success_console' },
        { command: 'pytest -v', kind: 'test', strategy: 'test', label: 'test', failure_profile: 'test_failure_console', success_profile: 'test_success_console' },
        { command: 'jest --ci', kind: 'test', strategy: 'test', label: 'test', failure_profile: 'test_failure_console', success_profile: 'test_success_console' },
        { command: 'go test ./...', kind: 'test', strategy: 'test', label: 'test', failure_profile: 'test_failure_console', success_profile: 'test_success_console' },
        { command: 'cargo test', kind: 'test', strategy: 'test', label: 'test', failure_profile: 'test_failure_console', success_profile: 'test_success_console' },
        // Lint commands
        { command: 'eslint src/', kind: 'lint', strategy: 'lint', label: 'lint', failure_profile: 'lint_failure_console', success_profile: 'lint_success_console' },
        { command: 'npm run typecheck', kind: 'lint', strategy: 'lint', label: 'lint', failure_profile: 'lint_failure_console', success_profile: 'lint_success_console' },
        { command: 'npm run lint', kind: 'lint', strategy: 'lint', label: 'lint', failure_profile: 'lint_failure_console', success_profile: 'lint_success_console' },
        { command: 'cargo clippy', kind: 'lint', strategy: 'lint', label: 'lint', failure_profile: 'lint_failure_console', success_profile: 'lint_success_console' }
    ];

    for (const tc of testCases) {
        it(`classifies '${tc.command}' as ${tc.kind}/${tc.strategy}`, () => {
            const profile = getCompileCommandProfile(tc.command);

            assert.deepEqual(Object.keys(profile).sort(), [
                'failure_profile', 'kind', 'label', 'strategy', 'success_profile'
            ]);

            assert.equal(profile.kind, tc.kind, `kind mismatch for '${tc.command}'`);
            assert.equal(profile.strategy, tc.strategy, `strategy mismatch for '${tc.command}'`);
            assert.equal(profile.label, tc.label, `label mismatch for '${tc.command}'`);
            assert.equal(profile.failure_profile, tc.failure_profile, `failure_profile mismatch for '${tc.command}'`);
            assert.equal(profile.success_profile, tc.success_profile, `success_profile mismatch for '${tc.command}'`);
        });
    }

    it('unknown command returns generic compile profile', () => {
        const profile = getCompileCommandProfile('some-unknown-tool --build');
        assert.equal(profile.kind, 'compile');
        assert.equal(profile.strategy, 'generic');
        assert.equal(profile.failure_profile, 'compile_failure_console_generic');
    });

    it('empty command returns generic compile profile', () => {
        const profile = getCompileCommandProfile('');
        assert.equal(profile.kind, 'compile');
        assert.equal(profile.strategy, 'generic');
    });
});

// ============================================================================
// getCompileCommands — golden markdown extraction
// ============================================================================

describe('golden: getCompileCommands', () => {
    it('extracts commands from Compile Gate section', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-cmds-'));
        const filePath = path.join(dir, 'commands.md');
        const content = [
            '# Commands',
            '',
            '### Compile Gate (Mandatory)',
            '```bash',
            'npm run build',
            '```',
            '',
            'Rules:',
            '- First non-empty non-comment line is the compile command.',
            ''
        ].join('\n');
        fs.writeFileSync(filePath, content, 'utf8');
        try {
            const commands = getCompileCommands(filePath);
            assert.equal(commands.length, 1);
            assert.equal(commands[0], 'npm run build');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// getCompileFailureStrategyConfig — golden strategy configs
// ============================================================================

describe('golden: getCompileFailureStrategyConfig', () => {
    const strategies = ['maven', 'gradle', 'node', 'cargo', 'dotnet', 'go'];

    for (const strategy of strategies) {
        it(`returns valid config for strategy '${strategy}'`, () => {
            const config = getCompileFailureStrategyConfig(strategy);

            assert.ok('display_name' in config);
            assert.ok('full_patterns' in config);
            assert.ok('degraded_patterns' in config);
            assert.ok(Array.isArray(config.full_patterns));
            assert.ok(Array.isArray(config.degraded_patterns));
            assert.ok(config.full_patterns.length > 0, `${strategy} must have full patterns`);
            assert.ok(config.degraded_patterns.length > 0, `${strategy} must have degraded patterns`);

            // Patterns must be valid regexes
            for (const pattern of config.full_patterns) {
                assert.doesNotThrow(() => new RegExp(pattern), `invalid full pattern in ${strategy}: ${pattern}`);
            }
            for (const pattern of config.degraded_patterns) {
                assert.doesNotThrow(() => new RegExp(pattern), `invalid degraded pattern in ${strategy}: ${pattern}`);
            }
        });
    }

    it('unknown strategy returns generic fallback', () => {
        const config = getCompileFailureStrategyConfig('unknown-tool');
        assert.equal(config.display_name, 'generic-compile');
        assert.ok(config.full_patterns.length > 0);
    });

    it('maven config recognizes key patterns', () => {
        const config = getCompileFailureStrategyConfig('maven');
        assert.equal(config.display_name, 'maven');
        const fullSet = config.full_patterns.join('|');
        assert.ok(fullSet.includes('ERROR'));
        assert.ok(fullSet.includes('BUILD FAILURE'));
    });

    it('node config recognizes npm error pattern', () => {
        const config = getCompileFailureStrategyConfig('node');
        assert.equal(config.display_name, 'node-build');
        assert.ok(config.full_patterns.some(p => p.includes('npm ERR!')));
    });
});
