import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendMetricsEvent } from '../../../../src/gates/shared/hashing-metrics';

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-hashing-metrics-test-'));
}

function seedBundleRoot(bundleRoot: string): void {
    fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '', 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
}

test('appendMetricsEvent samples toxin snapshots instead of scanning on every event', () => {
    const tmpDir = makeTmpDir();
    try {
        seedBundleRoot(tmpDir);
        const metricsPath = path.join(tmpDir, 'runtime', 'metrics.jsonl');

        appendMetricsEvent(metricsPath, { gate: 'first' }, true, tmpDir);
        appendMetricsEvent(metricsPath, { gate: 'second' }, true, tmpDir);

        const lines = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        const parsed = lines.map(line => JSON.parse(line) as Record<string, unknown>);

        assert.equal(parsed.filter(entry => entry.gate === 'first').length, 1);
        assert.equal(parsed.filter(entry => entry.gate === 'second').length, 1);
        assert.equal(parsed.filter(entry => entry.metric_type === 'disk_artifact_growth').length, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
