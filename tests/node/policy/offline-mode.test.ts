import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    evaluateOfflinePolicy,
    assertOfflinePolicy,
    isNetworkSensitiveCommand,
    resolveOfflineActive,
    NETWORK_SENSITIVE_COMMANDS,
    type OfflinePolicyInput
} from '../../../src/policy/offline-mode';

describe('offline-mode', () => {
    describe('NETWORK_SENSITIVE_COMMANDS', () => {
        it('contains expected network-sensitive commands', () => {
            assert.ok(NETWORK_SENSITIVE_COMMANDS.includes('check-update'));
            assert.ok(NETWORK_SENSITIVE_COMMANDS.includes('update'));
            assert.ok(NETWORK_SENSITIVE_COMMANDS.includes('bootstrap'));
            assert.ok(NETWORK_SENSITIVE_COMMANDS.includes('install'));
            assert.ok(NETWORK_SENSITIVE_COMMANDS.includes('setup'));
        });

        it('does not contain local-only commands', () => {
            assert.ok(!NETWORK_SENSITIVE_COMMANDS.includes('status'));
            assert.ok(!NETWORK_SENSITIVE_COMMANDS.includes('doctor'));
            assert.ok(!NETWORK_SENSITIVE_COMMANDS.includes('verify'));
            assert.ok(!NETWORK_SENSITIVE_COMMANDS.includes('gate'));
            assert.ok(!NETWORK_SENSITIVE_COMMANDS.includes('cleanup'));
            assert.ok(!NETWORK_SENSITIVE_COMMANDS.includes('rollback'));
            assert.ok(!NETWORK_SENSITIVE_COMMANDS.includes('uninstall'));
        });
    });

    describe('resolveOfflineActive', () => {
        it('returns inactive when no flag and no env', () => {
            const result = resolveOfflineActive(false, undefined);
            assert.strictEqual(result.active, false);
            assert.strictEqual(result.source, 'none');
        });

        it('returns active with flag source when --offline flag is set', () => {
            const result = resolveOfflineActive(true, undefined);
            assert.strictEqual(result.active, true);
            assert.strictEqual(result.source, 'flag');
        });

        it('returns active with env source when GARDA_OFFLINE=1', () => {
            const result = resolveOfflineActive(false, '1');
            assert.strictEqual(result.active, true);
            assert.strictEqual(result.source, 'env');
        });

        it('accepts truthy env values: true, yes, y, on', () => {
            for (const val of ['true', 'yes', 'y', 'on', 'TRUE', 'Yes', 'ON']) {
                const result = resolveOfflineActive(false, val);
                assert.strictEqual(result.active, true, `expected active for env="${val}"`);
            }
        });

        it('rejects non-truthy env values', () => {
            for (const val of ['0', 'false', 'no', 'n', 'off', '', 'random']) {
                const result = resolveOfflineActive(false, val);
                assert.strictEqual(result.active, false, `expected inactive for env="${val}"`);
            }
        });

        it('flag takes priority over env', () => {
            const result = resolveOfflineActive(true, '1');
            assert.strictEqual(result.source, 'flag');
        });
    });

    describe('isNetworkSensitiveCommand', () => {
        it('returns true for network-sensitive commands', () => {
            assert.strictEqual(isNetworkSensitiveCommand('update'), true);
            assert.strictEqual(isNetworkSensitiveCommand('check-update'), true);
            assert.strictEqual(isNetworkSensitiveCommand('bootstrap'), true);
            assert.strictEqual(isNetworkSensitiveCommand('install'), true);
            assert.strictEqual(isNetworkSensitiveCommand('setup'), true);
        });

        it('returns false for local-only commands', () => {
            assert.strictEqual(isNetworkSensitiveCommand('status'), false);
            assert.strictEqual(isNetworkSensitiveCommand('doctor'), false);
            assert.strictEqual(isNetworkSensitiveCommand('gate'), false);
            assert.strictEqual(isNetworkSensitiveCommand('init'), false);
            assert.strictEqual(isNetworkSensitiveCommand('reinit'), false);
        });
    });

    describe('evaluateOfflinePolicy', () => {
        function makeInput(overrides: Partial<OfflinePolicyInput>): OfflinePolicyInput {
            return {
                offlineFlag: false,
                offlineEnv: undefined,
                forceNetwork: false,
                commandName: 'status',
                ...overrides
            };
        }

        it('allows any command when offline is not active', () => {
            const result = evaluateOfflinePolicy(makeInput({ commandName: 'update' }));
            assert.strictEqual(result.blocked, false);
            assert.strictEqual(result.offline, false);
        });

        it('allows local-only command when offline is active', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineFlag: true,
                commandName: 'status'
            }));
            assert.strictEqual(result.blocked, false);
            assert.strictEqual(result.offline, true);
            assert.strictEqual(result.commandRequiresNetwork, false);
        });

        it('blocks network-sensitive command when offline is active', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineFlag: true,
                commandName: 'update'
            }));
            assert.strictEqual(result.blocked, true);
            assert.strictEqual(result.offline, true);
            assert.strictEqual(result.commandRequiresNetwork, true);
            assert.strictEqual(result.forceNetwork, false);
            assert.ok(result.reason?.includes('offline mode is active'));
            assert.ok(result.reason?.includes('--force-network'));
        });

        it('blocks check-update when offline via env', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineEnv: 'true',
                commandName: 'check-update'
            }));
            assert.strictEqual(result.blocked, true);
            assert.strictEqual(result.offlineSource, 'env');
            assert.ok(result.reason?.includes('GARDA_OFFLINE'));
        });

        it('allows network-sensitive command when --force-network overrides offline', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineFlag: true,
                forceNetwork: true,
                commandName: 'update'
            }));
            assert.strictEqual(result.blocked, false);
            assert.strictEqual(result.offline, true);
            assert.strictEqual(result.forceNetwork, true);
            assert.strictEqual(result.commandRequiresNetwork, true);
            assert.strictEqual(result.reason, null);
        });

        it('reports correct offlineSource for flag', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineFlag: true,
                commandName: 'update'
            }));
            assert.strictEqual(result.offlineSource, 'flag');
            assert.ok(result.reason?.includes('--offline flag'));
        });

        it('reports correct offlineSource for env', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineEnv: '1',
                commandName: 'install'
            }));
            assert.strictEqual(result.offlineSource, 'env');
            assert.ok(result.reason?.includes('GARDA_OFFLINE'));
        });

        it('blocks setup when offline', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineFlag: true,
                commandName: 'setup'
            }));
            assert.strictEqual(result.blocked, true);
        });

        it('blocks bootstrap when offline', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineFlag: true,
                commandName: 'bootstrap'
            }));
            assert.strictEqual(result.blocked, true);
        });

        it('blocks install when offline', () => {
            const result = evaluateOfflinePolicy(makeInput({
                offlineFlag: true,
                commandName: 'install'
            }));
            assert.strictEqual(result.blocked, true);
        });
    });

    describe('assertOfflinePolicy', () => {
        it('returns result when command is not blocked', () => {
            const result = assertOfflinePolicy({
                offlineFlag: false,
                offlineEnv: undefined,
                forceNetwork: false,
                commandName: 'update'
            });
            assert.strictEqual(result.blocked, false);
        });

        it('throws when command is blocked', () => {
            assert.throws(
                () => assertOfflinePolicy({
                    offlineFlag: true,
                    offlineEnv: undefined,
                    forceNetwork: false,
                    commandName: 'update'
                }),
                (err: Error) => {
                    assert.ok(err.message.includes('offline mode is active'));
                    assert.ok(err.message.includes('--force-network'));
                    return true;
                }
            );
        });

        it('does not throw when --force-network overrides', () => {
            const result = assertOfflinePolicy({
                offlineFlag: true,
                offlineEnv: undefined,
                forceNetwork: true,
                commandName: 'check-update'
            });
            assert.strictEqual(result.blocked, false);
        });
    });

    describe('CLI integration (runCliMain)', () => {
        it('blocks network-sensitive command with --offline via runCliMain', async () => {
            const { runCliMain } = await import('../../../src/cli/main');
            await assert.rejects(
                () => runCliMain(['--offline', 'update', '--help-not-real-flag']),
                (err: Error) => {
                    assert.ok(err.message.includes('offline mode is active'));
                    return true;
                }
            );
        });

        it('allows --help introspection on network-sensitive command even with --offline', async () => {
            const { runCliMain } = await import('../../../src/cli/main');
            // update --help should not throw offline error; it will print help and return
            await runCliMain(['--offline', 'update', '--help']);
        });

        it('blocks via GARDA_OFFLINE env var through runCliMain', async () => {
            const { runCliMain } = await import('../../../src/cli/main');
            const saved = process.env.GARDA_OFFLINE;
            try {
                process.env.GARDA_OFFLINE = '1';
                await assert.rejects(
                    () => runCliMain(['check-update', '--dry-run']),
                    (err: Error) => {
                        assert.ok(err.message.includes('offline mode is active'));
                        return true;
                    }
                );
            } finally {
                if (saved === undefined) { delete process.env.GARDA_OFFLINE; } else { process.env.GARDA_OFFLINE = saved; }
            }
        });

        it('allows local-only command with --offline via runCliMain', async () => {
            const { runCliMain } = await import('../../../src/cli/main');
            // 'help' is always safe and local
            await runCliMain(['--offline', 'help']);
        });
    });
});
