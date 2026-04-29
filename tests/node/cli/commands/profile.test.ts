import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    handleProfile,
    buildProfileListOutput,
    buildProfileCurrentOutput,
    buildProfileUseOutput,
    buildProfileCreateOutput,
    buildProfileDeleteOutput,
    buildProfileValidateOutput
} from '../../../../src/cli/commands/profile';

const PACKAGE_JSON = { name: 'test-pkg', version: '1.0.0' };

function createTempBundleWithProfiles(profiles?: Record<string, unknown>): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const data = profiles || {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Default profile.',
                depth: 2,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: true }
            },
            fast: {
                description: 'Speed-optimised profile.',
                depth: 1,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: false },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
                skills: { auto_suggest: false }
            },
            strict: {
                description: 'Maximum rigour.',
                depth: 3,
                review_policy: { code: true, db: true, security: true, refactor: true },
                token_economy: { enabled: true, strip_examples: false, strip_code_blocks: false, scoped_diffs: true, compact_reviewer_output: false },
                skills: { auto_suggest: true }
            },
            'docs-only': {
                description: 'Documentation-focused profile.',
                depth: 1,
                review_policy: { code: false, db: false, security: false, refactor: false },
                token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: false, compact_reviewer_output: true },
                skills: { auto_suggest: false }
            }
        },
        user_profiles: {}
    };
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify(data, null, 2), 'utf8');
    return bundleRoot;
}

function captureConsole(fn: () => unknown): { lines: string[]; result: unknown } {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
        const result = fn();
        return { lines, result };
    } finally {
        console.log = originalLog;
    }
}

async function captureConsoleAsync(fn: () => Promise<unknown>): Promise<{ lines: string[]; result: unknown }> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
        const result = await fn();
        return { lines, result };
    } finally {
        console.log = originalLog;
    }
}

test('profile list shows all profiles with active marker', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['list', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('GARDA_PROFILES'));
    assert.ok(output.includes('ActiveProfile: balanced'));
    assert.ok(output.includes('(*)'));
    assert.ok(output.includes('balanced'));
    assert.ok(output.includes('fast'));
    assert.ok(output.includes('strict'));
    assert.ok(output.includes('docs-only'));
});

test('profile command without subcommand shows current profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('GARDA_PROFILES'));
    assert.ok(output.includes('Action: current'));
    assert.ok(output.includes('ActiveProfile: balanced'));
    assert.ok(output.includes('Tip: run "profile list" to inspect all available profiles.'));
});

test('profile list --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['list', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.active_profile, 'balanced');
    assert.ok(Array.isArray(parsed.built_in_profiles));
    assert.ok(parsed.built_in_profiles.includes('balanced'));
});

test('profile current shows active profile details', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['current', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('ActiveProfile: balanced'));
    assert.ok(output.includes('Type: built-in'));
    assert.ok(output.includes('Depth: 2'));
});

test('profile current --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['current', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.active_profile, 'balanced');
    assert.equal(parsed.is_built_in, true);
    assert.equal(parsed.entry.depth, 2);
});

test('profile use switches the active profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('PreviousProfile: balanced'));
    assert.ok(output.includes('ActiveProfile: fast'));
    assert.ok(output.includes('CHANGED'));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.equal(data.active_profile, 'fast');
});

test('profile use with nonexistent profile throws', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['use', 'nonexistent', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /not found/
    );
});

test('profile use with same profile shows NO_CHANGE', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['use', 'balanced', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('NO_CHANGE'));
});

test('profile create adds a user profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile([
        'create', 'my-custom',
        '--bundle-root', bundleRoot,
        '--description', 'A custom test profile',
        '--depth', '3'
    ], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('CREATED'));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(data.user_profiles['my-custom']);
    assert.equal(data.user_profiles['my-custom'].depth, 3);
    assert.equal(data.user_profiles['my-custom'].description, 'A custom test profile');
});

test('profile create with --copy-from clones an existing profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'strict-copy',
        '--bundle-root', bundleRoot,
        '--copy-from', 'strict',
        '--description', 'Strict clone'
    ], PACKAGE_JSON));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(data.user_profiles['strict-copy']);
    assert.equal(data.user_profiles['strict-copy'].depth, 3);
    assert.equal(data.user_profiles['strict-copy'].description, 'Strict clone');
    assert.equal(data.user_profiles['strict-copy'].review_policy.code, true);
});

test('profile create rejects name conflicting with built-in', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'balanced', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /already exists/
    );
});

test('profile create rejects invalid name', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'My Profile!', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Invalid profile name/
    );
});

test('profile create rejects invalid depth', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'test-bad', '--bundle-root', bundleRoot, '--depth', '5'], PACKAGE_JSON),
        /must be 1, 2, or 3/
    );
});

test('profile create without a name starts full interactive prompts when TTY is available', async () => {
    const bundleRoot = createTempBundleWithProfiles();
    const cliHelpersPath = require.resolve('../../../../src/cli/commands/cli-helpers');
    const cliHelpers = require(cliHelpersPath);
    const originals = {
        supportsInteractivePrompts: cliHelpers.supportsInteractivePrompts,
        promptTextInput: cliHelpers.promptTextInput,
        promptSingleSelect: cliHelpers.promptSingleSelect
    };

    cliHelpers.supportsInteractivePrompts = () => true;
    cliHelpers.promptTextInput = async (title: string) => {
        if (title === 'Enter profile name') return 'guided-profile';
        if (title === 'Enter profile description (defaults from profile \'strict\')') return 'Interactive guided profile';
        throw new Error(`Unexpected promptTextInput title: ${title}`);
    };
    cliHelpers.promptSingleSelect = async (config: { title: string }) => {
        switch (config.title) {
            case 'Choose base profile for new profile settings': return 'strict';
            case 'Select profile depth (from profile \'strict\')': return '2';
            case 'Customize review policy': return 'true';
            case 'Review policy: code (from base)': return 'true';
            case 'Review policy: db (from base)': return 'false';
            case 'Review policy: security (from base)': return 'true';
            case 'Review policy: refactor (from base)': return 'auto';
            case 'Review policy: api (from base)': return 'false';
            case 'Review policy: test (from base)': return 'true';
            case 'Review policy: performance (from base)': return 'false';
            case 'Review policy: infra (from base)': return 'false';
            case 'Review policy: dependency (from base)': return 'true';
            case 'Customize token economy': return 'true';
            case 'Token economy: enabled (from base)': return 'true';
            case 'Token economy: strip_examples (from base)': return 'false';
            case 'Token economy: strip_code_blocks (from base)': return 'false';
            case 'Token economy: scoped_diffs (from base)': return 'true';
            case 'Token economy: compact_reviewer_output (from base)': return 'false';
            case 'Customize skill behavior': return 'true';
            case 'Skills: auto_suggest': return 'false';
            default:
                throw new Error(`Unexpected promptSingleSelect title: ${config.title}`);
        }
    };

    try {
        const { lines } = await captureConsoleAsync(() => Promise.resolve(handleProfile([
            'create',
            '--bundle-root', bundleRoot
        ], PACKAGE_JSON)));
        const output = lines.join('\n');
        assert.ok(output.includes('CREATED'));
        assert.ok(output.includes("Defaults are copied from profile 'strict'. You can keep inherited values or override them."));

        const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
        const created = data.user_profiles['guided-profile'];
        assert.ok(created);
        assert.equal(created.description, 'Interactive guided profile');
        assert.equal(created.depth, 2);
        assert.equal(created.review_policy.code, true);
        assert.equal(created.review_policy.db, false);
        assert.equal(created.review_policy.refactor, 'auto');
        assert.equal(created.review_policy.test, true);
        assert.equal(created.review_policy.dependency, true);
        assert.equal(created.token_economy.strip_examples, false);
        assert.equal(created.token_economy.compact_reviewer_output, false);
        assert.equal(created.skills.auto_suggest, false);
    } finally {
        cliHelpers.supportsInteractivePrompts = originals.supportsInteractivePrompts;
        cliHelpers.promptTextInput = originals.promptTextInput;
        cliHelpers.promptSingleSelect = originals.promptSingleSelect;
    }
});

test('profile create without a name rejects when interactive prompts are unavailable', async () => {
    const bundleRoot = createTempBundleWithProfiles();
    const cliHelpersPath = require.resolve('../../../../src/cli/commands/cli-helpers');
    const cliHelpers = require(cliHelpersPath);
    const originalSupportsInteractivePrompts = cliHelpers.supportsInteractivePrompts;
    cliHelpers.supportsInteractivePrompts = () => false;
    try {
        await assert.rejects(
            async () => {
                await Promise.resolve(handleProfile(['create', '--bundle-root', bundleRoot], PACKAGE_JSON));
            },
            /TTY terminal/
        );
    } finally {
        cliHelpers.supportsInteractivePrompts = originalSupportsInteractivePrompts;
    }
});

test('profile create rejects --json in interactive mode', async () => {
    const bundleRoot = createTempBundleWithProfiles();
    await assert.rejects(
        async () => {
            await Promise.resolve(handleProfile(['create', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
        },
        /--json is not supported with interactive profile creation/
    );
});

test('profile delete removes a user profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'temp-profile',
        '--bundle-root', bundleRoot,
        '--description', 'Temporary'
    ], PACKAGE_JSON));
    const { lines } = captureConsole(() => handleProfile(['delete', 'temp-profile', '--bundle-root', bundleRoot], PACKAGE_JSON));
    const output = lines.join('\n');
    assert.ok(output.includes('DELETED'));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.equal(data.user_profiles['temp-profile'], undefined);
});

test('profile delete rejects built-in profile deletion', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['delete', 'balanced', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Cannot delete built-in profile/
    );
});

test('profile delete rejects deletion of nonexistent user profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['delete', 'nonexistent', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /not found/
    );
});

test('profile delete reassigns active profile to first built-in when deleting the active profile', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'custom-active',
        '--bundle-root', bundleRoot,
        '--description', 'Will become active then deleted'
    ], PACKAGE_JSON));
    captureConsole(() => handleProfile(['use', 'custom-active', '--bundle-root', bundleRoot], PACKAGE_JSON));
    captureConsole(() => handleProfile(['delete', 'custom-active', '--bundle-root', bundleRoot], PACKAGE_JSON));

    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.equal(data.user_profiles['custom-active'], undefined);
    assert.ok(data.active_profile in data.built_in_profiles, 'Active profile should fall back to a built-in');
});

test('profile validate passes for valid profiles', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    assert.ok(result && typeof result === 'object');
    assert.equal((result as { passed: boolean }).passed, true);
});

test('profile validate --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.validation, 'PASS');
    assert.equal(parsed.issue_count, 0);
});

test('profile with unknown subcommand throws', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['unknown-action', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Unknown profile action/
    );
});

test('profile list throws when profiles.json is missing', () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-'));
    assert.throws(
        () => handleProfile(['list', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Profiles config not found/
    );
});

test('buildProfileListOutput formats text correctly', () => {
    const data = {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: { description: 'Default.', depth: 2, review_policy: { code: true }, token_economy: { enabled: true }, skills: { auto_suggest: true } }
        },
        user_profiles: {
            custom: { description: 'Custom.', depth: 1, review_policy: { code: false }, token_economy: { enabled: false }, skills: { auto_suggest: false } }
        }
    } as any;
    const output = buildProfileListOutput(data, '/bundle', false);
    assert.ok(output.includes('GARDA_PROFILES'));
    assert.ok(output.includes('balanced'));
    assert.ok(output.includes('custom'));
    assert.ok(output.includes('User Profiles'));
});

test('buildProfileCurrentOutput text includes all fields', () => {
    const data = {
        version: 1,
        active_profile: 'fast',
        built_in_profiles: {
            fast: { description: 'Fast.', depth: 1, review_policy: { code: true }, token_economy: { enabled: true }, skills: { auto_suggest: false } }
        },
        user_profiles: {}
    } as any;
    const output = buildProfileCurrentOutput(data, '/bundle', false);
    assert.ok(output.includes('ActiveProfile: fast'));
    assert.ok(output.includes('Type: built-in'));
    assert.ok(output.includes('Depth: 1'));
    assert.ok(output.includes('Why: Active profile settings are used by default.'));
    assert.ok(output.includes('Tip: run "profile list" to inspect all available profiles.'));
});

test('buildProfileUseOutput shows CHANGED vs NO_CHANGE', () => {
    assert.ok(buildProfileUseOutput('fast', 'balanced', false).includes('CHANGED'));
    assert.ok(buildProfileUseOutput('balanced', 'balanced', false).includes('NO_CHANGE'));
});

test('buildProfileCreateOutput shows CREATED', () => {
    const output = buildProfileCreateOutput('test-profile', '/config/profiles.json', false);
    assert.ok(output.includes('CREATED'));
    assert.ok(output.includes('test-profile'));
});

test('buildProfileDeleteOutput shows DELETED', () => {
    const output = buildProfileDeleteOutput('test-profile', '/config/profiles.json', false);
    assert.ok(output.includes('DELETED'));
    assert.ok(output.includes('test-profile'));
});

test('buildProfileValidateOutput shows PASS/FAIL', () => {
    const data = { version: 1, active_profile: 'balanced', built_in_profiles: { balanced: {} }, user_profiles: {} } as any;
    assert.ok(buildProfileValidateOutput(data, [], '/config', false).includes('PASS'));
    assert.ok(buildProfileValidateOutput(data, ['bad'], '/config', false).includes('FAIL'));
});

test('profile create accepts valid kebab-case names', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'my-profile-2',
        '--bundle-root', bundleRoot,
        '--description', 'Valid name'
    ], PACKAGE_JSON));
    const data = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live', 'config', 'profiles.json'), 'utf8'));
    assert.ok(data.user_profiles['my-profile-2']);
});

test('profile create rejects names starting with digit', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', '1bad', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Invalid profile name/
    );
});

test('profile create rejects names with uppercase', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'BadName', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Invalid profile name/
    );
});

test('profile create rejects names ending with hyphen', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'bad-', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /Invalid profile name/
    );
});

test('profile create rejects non-integer depth like 2abc', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'test-strict', '--bundle-root', bundleRoot, '--depth', '2abc'], PACKAGE_JSON),
        /must be 1, 2, or 3/
    );
});

test('profile create rejects empty description', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['create', 'test-empty', '--bundle-root', bundleRoot, '--description', ''], PACKAGE_JSON),
        /must not be empty/
    );
});

test('profile use rejects prototype-chain names like constructor', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['use', 'constructor', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /not found/
    );
});

test('profile delete rejects prototype-chain names like toString', () => {
    const bundleRoot = createTempBundleWithProfiles();
    assert.throws(
        () => handleProfile(['delete', 'toString', '--bundle-root', bundleRoot], PACKAGE_JSON),
        /not found/
    );
});

test('profile use --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile(['use', 'fast', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.action, 'use');
    assert.equal(parsed.active_profile, 'fast');
    assert.equal(parsed.previous_profile, 'balanced');
    assert.equal(parsed.changed, true);
});

test('profile create --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    const { lines } = captureConsole(() => handleProfile([
        'create', 'json-test',
        '--bundle-root', bundleRoot,
        '--description', 'For JSON',
        '--json'
    ], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.action, 'create');
    assert.equal(parsed.profile, 'json-test');
});

test('profile delete --json returns valid JSON', () => {
    const bundleRoot = createTempBundleWithProfiles();
    captureConsole(() => handleProfile([
        'create', 'del-json',
        '--bundle-root', bundleRoot,
        '--description', 'Will delete'
    ], PACKAGE_JSON));
    const { lines } = captureConsole(() => handleProfile(['delete', 'del-json', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.action, 'delete');
    assert.equal(parsed.profile, 'del-json');
});

test('profile validate reports FAIL for malformed profiles.json', () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), '{"version":1}', 'utf8');
    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    assert.ok(result && typeof result === 'object');
    assert.equal((result as { passed: boolean }).passed, false);
});

test('profile validate reports FAIL when profiles.json is missing', () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-profile-'));
    const { result } = captureConsole(() => handleProfile(['validate', '--bundle-root', bundleRoot], PACKAGE_JSON));
    assert.ok(result && typeof result === 'object');
    assert.equal((result as { passed: boolean }).passed, false);
});
