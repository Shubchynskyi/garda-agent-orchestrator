import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../../src/core/constants';
import {
    buildFullSuiteConfigSignature,
    loadFullSuiteValidationConfig} from '../../../../src/gates/full-suite/full-suite-validation';





describe('gates/full-suite-validation', () => {
    describe('loadFullSuiteValidationConfig', () => {
        it('returns defaults when config file does not exist', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent/path');
            assert.equal(config.enabled, false);
            assert.equal(config.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            assert.equal(config.timeout_ms, 600_000);
            assert.equal(config.timeout_blocker, true);
            assert.equal(config.timeout_retry_count, 1);
            assert.equal(config.green_summary_max_lines, 5);
            assert.equal(config.red_failure_chunk_lines, 50);
            assert.equal(config.out_of_scope_failure_policy, 'AUDIT_AND_BLOCK');
            assert.equal(config.placement, 'after_compile_before_reviews');
        });

        it('loads enabled config from valid JSON', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:all',
                    timeout_ms: 300000,
                    timeout_blocker: false,
                    timeout_retry_count: 0,
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                    placement: 'before completion'
                }
            }));

            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.enabled, true);
            assert.equal(config.command, 'npm run test:all');
            assert.equal(config.timeout_ms, 300000);
            assert.equal(config.timeout_blocker, false);
            assert.equal(config.timeout_retry_count, 0);
            assert.equal(config.green_summary_max_lines, 3);
            assert.equal(config.red_failure_chunk_lines, 25);
            assert.equal(config.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
            assert.equal(config.placement, 'before_completion');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('loads full-suite timeout policy from normalized string config values', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:all',
                    timeout_ms: 300000,
                    timeout_blocker: 'no',
                    timeout_retry_count: '0',
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                    placement: 'before completion'
                }
            }));

            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.timeout_blocker, false);
            assert.equal(config.timeout_retry_count, 0);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('defaults excessive full-suite timeout retry count from config', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:all',
                    timeout_ms: 300000,
                    timeout_retry_count: 4,
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                    placement: 'before completion'
                }
            }));

            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.timeout_retry_count, 1);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('returns defaults for malformed JSON', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), 'not json');
            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.enabled, false);
            assert.equal(config.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('returns defaults for parseable non-object JSON', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), 'null');
            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.enabled, false);
            assert.equal(config.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            assert.equal(config.placement, 'after_compile_before_reviews');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects invalid explicit placement values', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test',
                    timeout_ms: 300000,
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after lunch'
                }
            }));

            assert.throws(
                () => loadFullSuiteValidationConfig(tempDir),
                /workflow-config\.full_suite_validation\.placement must be one of/
            );
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('includes timeout policy fields in the config signature', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent/path');
            assert.notEqual(
                buildFullSuiteConfigSignature(config),
                buildFullSuiteConfigSignature({ ...config, timeout_blocker: false })
            );
            assert.notEqual(
                buildFullSuiteConfigSignature(config),
                buildFullSuiteConfigSignature({ ...config, timeout_retry_count: 0 })
            );
        });
    });
});
