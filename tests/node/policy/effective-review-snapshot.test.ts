import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeReviewCatalog, readReviewCatalogConfigFile } from '../../../src/core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../src/core/review-capabilities';
import {
    assertEffectiveReviewSnapshotCurrent,
    buildEffectiveReviewSnapshot,
    collectKnownReviewSkillIds,
    deriveReviewPackageHints,
    getEffectiveReviewSnapshotViolations,
    resolveEffectiveReviewTaskIntent
} from '../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../src/policy/profile-review-catalog-policy';
import { buildTaskProfilePolicySnapshot } from '../../../src/policy/task-profile-policy-snapshot';
import {
    REVIEW_CONTRACTS,
    readConfiguredReviewContracts,
    resolveExpectedReviewVerdicts,
    validatePreflightForReview
} from '../../../src/gates/required-reviews/required-reviews-check-contracts';

const PROFILE_HASH = 'a'.repeat(64);

test('configured implemented skills extend catalog validation without selecting a review lane', () => {
    const knownSkillIds = collectKnownReviewSkillIds([
        {
            id: 'architecture-review',
            directory: 'architecture-review',
            implemented: true
        },
        {
            id: 'placeholder-review',
            directory: 'placeholder-review',
            implemented: false
        }
    ]);

    assert.ok(knownSkillIds.includes('architecture-review'));
    assert.ok(!knownSkillIds.includes('placeholder-review'));
    assert.doesNotThrow(() => normalizeReviewCatalog({
        version: 1,
        custom_review_types: [
            {
                id: 'architecture-boundary',
                display_label: 'Architecture boundary review',
                enabled_by_default: false,
                skill_id: 'architecture-review',
                trigger: { mode: 'manual' },
                coverage_category_ids: ['maintainability'],
                reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
            }
        ]
    }, { knownSkillIds }));

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-review-contracts-'));
    try {
        const configDir = path.join(tmpRoot, 'live', 'config');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'review-catalog.json'), JSON.stringify({
            version: 1,
            custom_review_types: [
                {
                    id: 'architecture-boundary',
                    display_label: 'Architecture boundary review',
                    enabled_by_default: false,
                    skill_id: 'architecture-review',
                    trigger: { mode: 'manual' },
                    coverage_category_ids: ['maintainability'],
                    reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
                }
            ]
        }), 'utf8');
        fs.writeFileSync(path.join(configDir, 'skills-headlines.json'), JSON.stringify({
            version: 2,
            installed_pack_ids: [],
            baseline_skill_ids: [],
            installed_optional_skill_ids: [],
            custom_skill_ids: ['architecture-review'],
            skills: [
                {
                    id: 'architecture-review',
                    directory: 'architecture-review',
                    name: 'Architecture review',
                    summary: 'Reviews architectural boundaries.',
                    pack: null,
                    source: 'custom_live',
                    implemented: true,
                    review_binding: 'review_bound',
                    aliases: [],
                    task_signals: [],
                    changed_path_signals: [],
                    tags: []
                }
            ],
            optional_packs: []
        }), 'utf8');

        assert.deepEqual(readConfiguredReviewContracts(tmpRoot), [
            ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED']
        ]);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('effective review task intent falls back to the stored task summary', () => {
    assert.equal(
        resolveEffectiveReviewTaskIntent(undefined, 'Build the architecture boundary'),
        'Build the architecture boundary'
    );
    assert.equal(
        resolveEffectiveReviewTaskIntent('Explicit security intent', 'Stored task summary'),
        'Explicit security intent'
    );
});

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
            result[key] = canonicalize((value as Record<string, unknown>)[key]);
            return result;
        }, {});
    }
    return value;
}

function rehashSnapshot(snapshot: Record<string, unknown>): void {
    const { snapshot_sha256: ignored, ...body } = snapshot;
    void ignored;
    snapshot.snapshot_sha256 = createHash('sha256')
        .update(JSON.stringify(canonicalize(body)), 'utf8')
        .digest('hex');
}

function buildCatalog(signalIds: string[] = ['package:payments', 'skill:node-backend', 'task:architecture']) {
    return normalizeReviewCatalog({
        version: 1,
        custom_review_types: [
            {
                id: 'architecture-boundary',
                display_label: 'Architecture boundary review',
                enabled_by_default: false,
                skill_id: 'architecture-review',
                trigger: {
                    mode: 'signals',
                    signal_ids: signalIds
                },
                coverage_category_ids: ['maintainability'],
                reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
            }
        ]
    }, { knownSkillIds: ['architecture-review'] });
}

function buildSnapshot(
    profileState: boolean | 'auto',
    input: Partial<Parameters<typeof buildEffectiveReviewSnapshot>[0]> = {},
    control: {
        profileOverrides?: Readonly<Record<string, boolean | 'auto'>>;
        signalIds?: string[];
    } = {}
) {
    const catalog = buildCatalog(control.signalIds);
    const capabilities = Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        { ...control.profileOverrides, 'architecture-boundary': profileState },
        capabilities,
        catalog
    );
    return buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: PROFILE_HASH,
        legacyRequiredReviews: { code: true },
        scopeCategory: 'code',
        taskIntent: 'Change a small handler',
        changedFiles: ['packages/payments/src/handler.ts'],
        taskTriggers: { api: true },
        ...input
    });
}

test('effective review snapshot preserves built-in requirements and never triggers a disabled custom lane', () => {
    const snapshot = buildSnapshot(false, {
        taskIntent: 'Architecture change',
        optionalSkillIds: ['node-backend']
    });

    assert.equal(snapshot.required_reviews.code, true);
    assert.equal(snapshot.required_reviews['architecture-boundary'], false);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.inactive_reasons,
        ['profile_disabled']
    );
});

test('explicit built-in profile policy takes precedence over compatibility requirements', () => {
    const requiredByProfile = buildSnapshot('auto', {
        legacyRequiredReviews: { code: false }
    }, { profileOverrides: { code: true } });
    const disabledByProfile = buildSnapshot('auto', {
        legacyRequiredReviews: { code: true }
    }, { profileOverrides: { code: false } });

    assert.equal(requiredByProfile.required_reviews.code, true);
    assert.deepEqual(
        requiredByProfile.lanes.find((lane) => lane.id === 'code')?.trigger_reasons,
        ['profile_state=required']
    );
    assert.equal(disabledByProfile.required_reviews.code, false);
    assert.deepEqual(
        disabledByProfile.lanes.find((lane) => lane.id === 'code')?.inactive_reasons,
        ['profile_disabled']
    );
});

test('zero-diff baseline suppresses profile-required built-in and custom lanes', () => {
    const snapshot = buildSnapshot(true, {
        zeroDiffBaselineOnly: true
    }, { profileOverrides: { code: true } });

    assert.equal(snapshot.required_reviews.code, false);
    assert.equal(snapshot.required_reviews['architecture-boundary'], false);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'code')?.inactive_reasons,
        ['zero_diff_no_reviewable_scope']
    );
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.inactive_reasons,
        ['zero_diff_no_reviewable_scope']
    );
});

test('auto custom lane requires an explicitly configured deterministic signal', () => {
    const unmatched = buildSnapshot('auto', {
        changedFiles: ['src/handler.ts'],
        taskIntent: 'Change a small handler',
        optionalSkillIds: []
    });
    const matched = buildSnapshot('auto', { optionalSkillIds: ['node-backend'] });

    assert.equal(unmatched.required_reviews['architecture-boundary'], false);
    assert.deepEqual(
        unmatched.lanes.find((lane) => lane.id === 'architecture-boundary')?.inactive_reasons,
        ['configured_signals_not_matched']
    );
    assert.equal(matched.required_reviews['architecture-boundary'], true);
    assert.deepEqual(
        matched.lanes.find((lane) => lane.id === 'architecture-boundary')?.trigger_reasons,
        ['package:payments=package_hint', 'skill:node-backend=selected_optional_skill']
    );
});

test('composed configured signal tokens preserve the first namespace delimiter', () => {
    const snapshot = buildSnapshot('auto', {
        changedFiles: ['src/handler.ts'],
        taskIntent: 'Change the architecture boundary'
    }, { signalIds: ['task:architecture.boundary'] });

    assert.equal(snapshot.required_reviews['architecture-boundary'], true);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.trigger_reasons,
        ['task:architecture.boundary=task_intent_token']
    );
});

test('configured stable trigger signals map to exact underscore preflight identifiers', () => {
    const snapshot = buildSnapshot('auto', {
        taskTriggers: { protected_control_plane_changed: true }
    }, { signalIds: ['trigger:protected-control-plane-changed'] });

    assert.equal(snapshot.required_reviews['architecture-boundary'], true);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.trigger_reasons,
        ['trigger:protected-control-plane-changed=task_scope_trigger']
    );
});

test('required custom lane is selected without treating skill availability as a trigger', () => {
    const snapshot = buildSnapshot(true, {
        changedFiles: ['src/handler.ts'],
        optionalSkillIds: []
    });

    assert.equal(snapshot.required_reviews['architecture-boundary'], true);
    assert.deepEqual(
        snapshot.lanes.find((lane) => lane.id === 'architecture-boundary')?.trigger_reasons,
        ['profile_state=required']
    );
});

test('required custom lane is included in downstream verdict contracts', () => {
    const snapshot = buildSnapshot(true, {
        changedFiles: ['src/handler.ts'],
        optionalSkillIds: []
    });

    const verdicts = resolveExpectedReviewVerdicts(snapshot.required_reviews);

    assert.equal(verdicts['architecture-boundary'], 'ARCHITECTURE BOUNDARY REVIEW PASSED');
    assert.deepEqual(
        REVIEW_CONTRACTS.find(([reviewId]) => reviewId === 'architecture-boundary'),
        ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED']
    );
});

test('rejects self-hashed fabricated or inconsistent review-routing decisions', () => {
    const snapshot = buildSnapshot('auto', {}, { profileOverrides: { code: true } });
    const nonBoolean = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    (nonBoolean.required_reviews as Record<string, unknown>).code = 'false';
    rehashSnapshot(nonBoolean);

    assert.ok(getEffectiveReviewSnapshotViolations(nonBoolean).some(
        (violation) => /required_reviews\.code must be boolean/u.test(violation)
    ));

    const suppressedRequired = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const codeLane = (suppressedRequired.lanes as Array<Record<string, unknown>>)
        .find((lane) => lane.id === 'code');
    assert.ok(codeLane);
    codeLane.selection = 'optional';
    codeLane.trigger_reasons = ['built_in_compatibility_not_required'];
    (suppressedRequired.required_reviews as Record<string, unknown>).code = false;
    (suppressedRequired.optional_reviews as Record<string, unknown>).code = true;
    suppressedRequired.required_review_ids = (suppressedRequired.required_review_ids as string[])
        .filter((id) => id !== 'code');
    suppressedRequired.optional_review_ids = ['code', ...(suppressedRequired.optional_review_ids as string[])];
    rehashSnapshot(suppressedRequired);

    assert.ok(getEffectiveReviewSnapshotViolations(suppressedRequired).some(
        (violation) => /required profile lane 'code' must be required/u.test(violation)
    ));
});

test('canonical reconstruction rejects a self-rehashed auto-lane suppression', () => {
    const catalog = buildCatalog();
    const capabilities = Object.fromEntries(
        catalog.review_types.map((definition) => [definition.id, true])
    ) as ReviewCapabilitiesConfigMap;
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'balanced',
        { 'architecture-boundary': 'auto' },
        capabilities,
        catalog
    );
    const snapshot = buildEffectiveReviewSnapshot({
        catalog,
        profilePolicy,
        profileSnapshotSha256: PROFILE_HASH,
        legacyRequiredReviews: { code: true },
        scopeCategory: 'code',
        taskIntent: 'Change a small handler',
        changedFiles: ['packages/payments/src/handler.ts'],
        taskTriggers: { api: true }
    });
    const suppressed = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    const lane = (suppressed.lanes as Array<Record<string, unknown>>)
        .find((entry) => entry.id === 'architecture-boundary');
    assert.ok(lane);
    lane.selection = 'inactive';
    lane.trigger_reasons = [];
    lane.inactive_reasons = ['configured_signals_not_matched'];
    (suppressed.required_reviews as Record<string, unknown>)['architecture-boundary'] = false;
    suppressed.required_review_ids = (suppressed.required_review_ids as string[])
        .filter((id) => id !== 'architecture-boundary');
    rehashSnapshot(suppressed);

    assert.deepEqual(getEffectiveReviewSnapshotViolations(suppressed), []);
    assert.throws(
        () => assertEffectiveReviewSnapshotCurrent(
            suppressed as unknown as Parameters<typeof assertEffectiveReviewSnapshotCurrent>[0],
            catalog,
            PROFILE_HASH,
            profilePolicy
        ),
        /canonical reconstruction mismatch/u
    );
});

test('rejects catalog and profile drift before downstream review routing', () => {
    const snapshot = buildSnapshot('auto');
    assert.deepEqual(getEffectiveReviewSnapshotViolations(snapshot), []);
    assert.doesNotThrow(() => assertEffectiveReviewSnapshotCurrent(snapshot, snapshot.catalog_sha256, PROFILE_HASH));
    assert.throws(
        () => assertEffectiveReviewSnapshotCurrent(snapshot, 'b'.repeat(64), PROFILE_HASH),
        /catalog drift detected/u
    );
    assert.throws(
        () => assertEffectiveReviewSnapshotCurrent(snapshot, snapshot.catalog_sha256, 'c'.repeat(64)),
        /profile drift detected/u
    );

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'effective-review-preflight-'));
    try {
        const bundleRoot = path.join(tmpRoot, 'garda-agent-orchestrator');
        const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
        const configDir = path.join(bundleRoot, 'live', 'config');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
            path.join(configDir, 'review-catalog.json'),
            JSON.stringify({ version: 1, custom_review_types: [] }),
            'utf8'
        );
        const preflightPath = path.join(reviewsDir, 'T-729-3-preflight.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: snapshot.required_reviews,
            profile_policy_snapshot: { snapshot_hash: PROFILE_HASH }
        }), 'utf8');
        const missingSnapshot = validatePreflightForReview(preflightPath, 'T-729-3');
        assert.ok(missingSnapshot.errors.some(
            (error) => /effective_review_snapshot.*required for downstream review routing/u.test(error)
        ));

        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: { ...snapshot.required_reviews, injected: true },
            profile_policy_snapshot: { snapshot_hash: PROFILE_HASH },
            effective_review_snapshot: snapshot
        }), 'utf8');
        const injectedProjection = validatePreflightForReview(preflightPath, 'T-729-3');
        assert.ok(injectedProjection.errors.some(
            (error) => /required_reviews.*must contain exactly the review ids/u.test(error)
        ));

        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: snapshot.required_reviews,
            profile_policy_snapshot: { snapshot_hash: PROFILE_HASH },
            effective_review_snapshot: snapshot
        }), 'utf8');

        REVIEW_CONTRACTS.splice(
            0,
            REVIEW_CONTRACTS.length,
            ...REVIEW_CONTRACTS.filter(([reviewId]) => reviewId !== 'architecture-boundary')
        );
        const catalogDrift = validatePreflightForReview(preflightPath, 'T-729-3');
        assert.equal(catalogDrift.required_reviews['architecture-boundary'], true);
        assert.deepEqual(
            REVIEW_CONTRACTS.find(([reviewId]) => reviewId === 'architecture-boundary'),
            ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED']
        );
        assert.ok(catalogDrift.errors.some((error) => /catalog drift detected/u.test(error)));

        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: snapshot.required_reviews,
            profile_policy_snapshot: { snapshot_hash: 'c'.repeat(64) },
            effective_review_snapshot: snapshot
        }), 'utf8');
        const profileDrift = validatePreflightForReview(preflightPath, 'T-729-3');
        assert.ok(profileDrift.errors.some((error) => /profile drift detected/u.test(error)));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('downstream routing rejects live profile input drift after preflight', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'effective-review-profile-drift-'));
    try {
        const bundleRoot = path.join(tmpRoot, 'garda-agent-orchestrator');
        const configDir = path.join(bundleRoot, 'live', 'config');
        const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
        fs.cpSync(path.resolve('garda-agent-orchestrator', 'live', 'config'), configDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });

        const frozenProfileSnapshot = buildTaskProfilePolicySnapshot(bundleRoot, 'balanced', {
            reviewExecutionPolicyMode: 'strict_sequential',
            reviewExecutionPolicyConfigured: true,
            lockTimestampUtc: '2026-01-01T00:00:00.000Z'
        });
        const catalog = readReviewCatalogConfigFile(path.join(configDir, 'review-catalog.json'));
        const profilePolicy = resolveProfileReviewCatalogPolicy(
            frozenProfileSnapshot.source.effective_profile,
            frozenProfileSnapshot.review_lane_selection.profile_review_policy,
            frozenProfileSnapshot.review_lane_selection.review_capabilities,
            catalog
        );
        const legacyRequiredReviews = Object.fromEntries(
            catalog.review_types.map((definition) => [definition.id, definition.id === 'code'])
        );
        const snapshot = buildEffectiveReviewSnapshot({
            catalog,
            profilePolicy,
            profileSnapshotSha256: frozenProfileSnapshot.snapshot_hash,
            legacyRequiredReviews,
            scopeCategory: 'code',
            taskIntent: 'Exercise profile drift detection',
            changedFiles: ['src/handler.ts'],
            taskTriggers: {}
        });
        const preflightPath = path.join(reviewsDir, 'T-729-3-preflight.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-729-3',
            required_reviews: snapshot.required_reviews,
            profile_policy_snapshot: frozenProfileSnapshot,
            effective_review_snapshot: snapshot
        }), 'utf8');
        fs.writeFileSync(path.join(reviewsDir, 'T-729-3-task-mode.json'), JSON.stringify({
            profile_policy_snapshot: frozenProfileSnapshot
        }), 'utf8');

        assert.deepEqual(validatePreflightForReview(preflightPath, 'T-729-3').errors, []);
        fs.appendFileSync(path.join(configDir, 'profiles.json'), '\n', 'utf8');

        assert.ok(validatePreflightForReview(preflightPath, 'T-729-3').errors.some(
            (error) => /profile policy inputs changed after preflight \(profiles\)/iu.test(error)
        ));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('package hints are bounded exact tokens derived from conventional workspace roots', () => {
    assert.deepEqual(deriveReviewPackageHints([
        'packages/payments/src/index.ts',
        'apps/admin-ui/src/app.ts',
        'package.json',
        'src/unscoped.ts'
    ]), ['admin-ui', 'payments', 'root']);
});
