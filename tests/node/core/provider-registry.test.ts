/**
 * T-110: Regression tests proving that the canonical provider registry stays
 * in sync with derived helpers (constants, materialization profiles, reviewer routing).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    getProviderEntries,
    getProviderIds,
    getProviderEntrypointMap,
    getProviderEntrypointFiles,
    getProviderAliasMap,
    getProviderBridgeEntries,
    getReviewerCapabilityTier
} from '../../../src/core/provider-registry';
import {
    SOURCE_OF_TRUTH_VALUES,
    SOURCE_TO_ENTRYPOINT_MAP,
    ALL_AGENT_ENTRYPOINT_FILES
} from '../../../src/core/constants';
import {
    getCanonicalEntrypointFile,
    getProviderOrchestratorProfileDefinitions
} from '../../../src/materialization/common';
import {
    resolveReviewerRoutingPolicy
} from '../../../src/gates/reviewer-routing';

// ===========================================================================
// 1. Registry internal consistency
// ===========================================================================

describe('provider-registry: internal consistency', () => {
    it('has no duplicate provider ids', () => {
        const ids = getProviderIds();
        assert.strictEqual(ids.length, new Set(ids).size);
    });

    it('has no duplicate entrypoint files', () => {
        const files = getProviderEntrypointFiles();
        assert.strictEqual(files.length, new Set(files).size);
    });

    it('every entry has at least one alias', () => {
        for (const entry of getProviderEntries()) {
            assert.ok(entry.aliases.length > 0, `${entry.id} has no aliases`);
        }
    });

    it('registry entries are deeply frozen and immutable', () => {
        const entries = getProviderEntries();
        assert.ok(Object.isFrozen(entries), 'entries array must be frozen');
        for (const entry of entries) {
            assert.ok(Object.isFrozen(entry), `entry ${entry.id} must be frozen`);
            assert.ok(Object.isFrozen(entry.aliases), `aliases for ${entry.id} must be frozen`);
            if (entry.bridge) {
                assert.ok(Object.isFrozen(entry.bridge), `bridge for ${entry.id} must be frozen`);
                assert.ok(Object.isFrozen(entry.bridge.gitignoreEntries), `bridge.gitignoreEntries for ${entry.id} must be frozen`);
            }
        }
    });

    it('alias map values point to valid entrypoint files', () => {
        const validFiles = new Set(getProviderEntrypointFiles());
        for (const [alias, file] of Object.entries(getProviderAliasMap())) {
            assert.ok(validFiles.has(file), `Alias '${alias}' maps to unknown file '${file}'`);
        }
    });

    it('bridge entries all have non-null bridge field', () => {
        for (const entry of getProviderBridgeEntries()) {
            assert.ok(entry.bridge !== null, `${entry.id} returned from getProviderBridgeEntries but bridge is null`);
        }
    });
});

// ===========================================================================
// 2. Derived constants stay in sync with registry
// ===========================================================================

describe('provider-registry: derived constants sync', () => {
    it('SOURCE_OF_TRUTH_VALUES matches registry provider ids', () => {
        assert.deepStrictEqual([...SOURCE_OF_TRUTH_VALUES], [...getProviderIds()]);
    });

    it('SOURCE_TO_ENTRYPOINT_MAP matches registry entrypoint map', () => {
        const registryMap = getProviderEntrypointMap();
        for (const [key, value] of Object.entries(SOURCE_TO_ENTRYPOINT_MAP)) {
            assert.strictEqual(registryMap[key], value, `Mismatch for provider '${key}'`);
        }
        for (const [key, value] of Object.entries(registryMap)) {
            assert.strictEqual((SOURCE_TO_ENTRYPOINT_MAP as Record<string, string>)[key], value, `Missing key '${key}' in SOURCE_TO_ENTRYPOINT_MAP`);
        }
    });

    it('ALL_AGENT_ENTRYPOINT_FILES matches registry entrypoint files', () => {
        assert.deepStrictEqual([...ALL_AGENT_ENTRYPOINT_FILES], [...getProviderEntrypointFiles()]);
    });
});

// ===========================================================================
// 3. Materialization profiles stay in sync
// ===========================================================================

describe('provider-registry: materialization profiles sync', () => {
    it('orchestrator profiles cover all providers with bridges', () => {
        const bridgeEntries = getProviderBridgeEntries();
        const profiles = getProviderOrchestratorProfileDefinitions();
        assert.strictEqual(profiles.length, bridgeEntries.length);

        const profilePaths = new Set(profiles.map((p) => p.orchestratorRelativePath));
        for (const entry of bridgeEntries) {
            assert.ok(
                profilePaths.has(entry.bridge!.orchestratorRelativePath),
                `Missing profile for bridge path '${entry.bridge!.orchestratorRelativePath}'`
            );
        }
    });

    it('getCanonicalEntrypointFile resolves all registered providers', () => {
        for (const id of getProviderIds()) {
            const file = getCanonicalEntrypointFile(id);
            const expected = getProviderEntrypointMap()[id];
            assert.strictEqual(file, expected, `getCanonicalEntrypointFile mismatch for '${id}'`);
        }
    });
});

// ===========================================================================
// 4. Reviewer routing stays in sync with capability tiers
// ===========================================================================

describe('provider-registry: reviewer routing sync', () => {
    it('resolveReviewerRoutingPolicy capability_level matches registry tier for all providers', () => {
        for (const entry of getProviderEntries()) {
            const policy = resolveReviewerRoutingPolicy(entry.id);
            const expectedTier = entry.reviewerCapabilityTier;
            assert.strictEqual(
                policy.capability_level, expectedTier,
                `Routing policy mismatch for '${entry.id}': got '${policy.capability_level}', expected '${expectedTier}'`
            );
        }
    });

    it('getReviewerCapabilityTier returns correct tier for each provider', () => {
        for (const entry of getProviderEntries()) {
            assert.strictEqual(getReviewerCapabilityTier(entry.id), entry.reviewerCapabilityTier);
        }
    });

    it('getReviewerCapabilityTier returns null for unknown provider', () => {
        assert.strictEqual(getReviewerCapabilityTier('UnknownProvider'), null);
    });

    it('delegation_required providers match known set', () => {
        const delegationRequired = getProviderEntries()
            .filter((e) => e.reviewerCapabilityTier === 'delegation_required')
            .map((e) => e.id)
            .sort();
        assert.deepStrictEqual(delegationRequired, ['Claude', 'Codex', 'GitHubCopilot']);
    });

    it('delegation_conditional providers match known set', () => {
        const delegationConditional = getProviderEntries()
            .filter((e) => e.reviewerCapabilityTier === 'delegation_conditional')
            .map((e) => e.id)
            .sort();
        assert.deepStrictEqual(delegationConditional, ['Antigravity', 'Junie', 'Windsurf']);
    });

    it('single_agent_only providers match known set', () => {
        const singleAgent = getProviderEntries()
            .filter((e) => e.reviewerCapabilityTier === 'single_agent_only')
            .map((e) => e.id)
            .sort();
        assert.deepStrictEqual(singleAgent, ['Gemini', 'Qwen']);
    });
});
