import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { syncWorkflowConfigWithTemplate } from '../../../src/core/workflow-config';

function mkTmpBundle(): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-config-'));
    fs.mkdirSync(path.join(bundleRoot, 'template', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    return bundleRoot;
}

function captureStderr(callback: () => void): string {
    const originalWrite = process.stderr.write;
    let output = '';
    (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = function (chunk: unknown): boolean {
        output += String(chunk);
        return true;
    };
    try {
        callback();
    } finally {
        (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
    }
    return output;
}

describe('workflow config template diagnostics', () => {
    it('warns when workflow-config template JSON is malformed before falling back to defaults', () => {
        const bundleRoot = mkTmpBundle();
        try {
            fs.writeFileSync(
                path.join(bundleRoot, 'template', 'config', 'workflow-config.json'),
                '{ invalid json',
                'utf8'
            );

            const stderr = captureStderr(() => {
                syncWorkflowConfigWithTemplate(bundleRoot);
            });

            assert.match(stderr, /WORKFLOW_CONFIG_TEMPLATE_FALLBACK/);
            assert.match(stderr, /reason=invalid_json_template:/);
            const materialized = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            assert.equal(materialized.full_suite_validation.enabled, false);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });

    it('warns when workflow-config template JSON is not an object before falling back to defaults', () => {
        const bundleRoot = mkTmpBundle();
        try {
            fs.writeFileSync(
                path.join(bundleRoot, 'template', 'config', 'workflow-config.json'),
                '[]',
                'utf8'
            );

            const stderr = captureStderr(() => {
                syncWorkflowConfigWithTemplate(bundleRoot);
            });

            assert.match(stderr, /WORKFLOW_CONFIG_TEMPLATE_FALLBACK/);
            assert.match(stderr, /reason=non_object_template/);
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    });
});
