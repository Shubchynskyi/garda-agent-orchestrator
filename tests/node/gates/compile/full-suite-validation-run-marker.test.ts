import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    readInterruptedFullSuiteValidationRunMarker,
    resolveFullSuiteValidationRunMarkerPath
} from '../../../../src/gates/full-suite/full-suite-validation-run-marker';
import { fileSha256, normalizePath } from '../../../../src/gates/shared/helpers';

describe('full-suite validation run marker', () => {
    it('rejects stale interrupted markers from a prior compile cycle with the same preflight', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-'));
        try {
            const taskId = 'T-MARKER';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath);
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            const cycleBinding = {
                task_id: taskId,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: preflightSha256,
                compile_gate_timestamp: '2026-06-07T01:00:00.000Z',
                scope_binding: null
            };
            fs.writeFileSync(markerPath, `${JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                status: 'running',
                started_at_utc: '2026-06-07T01:01:00.000Z',
                updated_at_utc: '2026-06-07T01:01:00.000Z',
                repo_root: normalizePath(repoRoot),
                cwd: normalizePath(repoRoot),
                command: 'npm test',
                timeout_ms: 600000,
                gate_pid: 999999,
                child_pid: null,
                child_command: null,
                child_args: [],
                child_shell: null,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: preflightSha256,
                cycle_binding: cycleBinding
            }, null, 2)}\n`, 'utf8');

            const stale = readInterruptedFullSuiteValidationRunMarker(
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                '2026-06-07T02:00:00.000Z'
            );
            const current = readInterruptedFullSuiteValidationRunMarker(
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                '2026-06-07T01:00:00.000Z'
            );

            assert.equal(stale, null);
            assert.equal(current?.command, 'npm test');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
