import {
    buildBuiltInReviewTypeDefinitions,
    type NormalizedReviewTypeDefinition
} from '../core/review-catalog';
import {
    getEffectiveReviewSnapshotViolations,
    type EffectiveReviewSelection,
    type EffectiveReviewSnapshot
} from './effective-review-snapshot';

export interface EffectiveReviewLaneContract {
    id: string;
    built_in: boolean;
    selection: EffectiveReviewSelection;
    pass_token: string;
    fail_token: string;
    definition: NormalizedReviewTypeDefinition;
    effective_review_snapshot_sha256: string | null;
    review_catalog_sha256: string | null;
}

export interface EffectiveReviewLaneSet {
    source: 'immutable_snapshot' | 'legacy_built_in_compatibility';
    lanes: readonly EffectiveReviewLaneContract[];
    required_review_ids: readonly string[];
    selected_review_ids: readonly string[];
    all_review_ids: readonly string[];
}

export interface ResolveEffectiveReviewLaneSetOptions {
    allowLegacyBuiltInFallback?: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildContract(
    definition: NormalizedReviewTypeDefinition,
    selection: EffectiveReviewSelection,
    snapshot: EffectiveReviewSnapshot | null
): EffectiveReviewLaneContract {
    return Object.freeze({
        id: definition.id,
        built_in: definition.built_in,
        selection,
        pass_token: definition.verdict_tokens.pass,
        fail_token: definition.verdict_tokens.fail,
        definition,
        effective_review_snapshot_sha256: snapshot?.snapshot_sha256 || null,
        review_catalog_sha256: snapshot?.catalog_sha256 || null
    });
}

function buildLaneSet(
    source: EffectiveReviewLaneSet['source'],
    lanes: readonly EffectiveReviewLaneContract[]
): EffectiveReviewLaneSet {
    return Object.freeze({
        source,
        lanes: Object.freeze([...lanes]),
        required_review_ids: Object.freeze(
            lanes.filter((lane) => lane.selection === 'required').map((lane) => lane.id)
        ),
        selected_review_ids: Object.freeze(
            lanes.filter((lane) => lane.selection !== 'inactive').map((lane) => lane.id)
        ),
        all_review_ids: Object.freeze(lanes.map((lane) => lane.id))
    });
}

function resolveSnapshotLaneSet(
    preflight: Record<string, unknown>,
    snapshot: EffectiveReviewSnapshot
): EffectiveReviewLaneSet {
    const violations = getEffectiveReviewSnapshotViolations(snapshot);
    if (violations.length > 0) {
        throw new Error(`Effective review snapshot is invalid. ${violations.join(' ')}`);
    }
    const requiredReviews = isPlainRecord(preflight.required_reviews)
        ? preflight.required_reviews
        : null;
    if (!requiredReviews) {
        throw new Error('Preflight required_reviews must accompany the immutable effective review snapshot.');
    }
    const snapshotIds = snapshot.lanes.map((lane) => lane.id);
    const requiredReviewIds = Object.keys(requiredReviews).sort();
    if (JSON.stringify([...snapshotIds].sort()) !== JSON.stringify(requiredReviewIds)) {
        throw new Error(
            'Preflight required_reviews must contain exactly the immutable effective review snapshot lane ids.'
        );
    }
    for (const lane of snapshot.lanes) {
        const expectedRequired = lane.selection === 'required';
        if (requiredReviews[lane.id] !== expectedRequired) {
            throw new Error(
                `Preflight required_reviews.${lane.id} does not match immutable lane selection '${lane.selection}'.`
            );
        }
    }
    return buildLaneSet(
        'immutable_snapshot',
        snapshot.lanes.map((lane) => buildContract(lane.definition, lane.selection, snapshot))
    );
}

function resolveLegacyBuiltInLaneSet(preflight: Record<string, unknown>): EffectiveReviewLaneSet {
    const requiredReviews = isPlainRecord(preflight.required_reviews)
        ? preflight.required_reviews
        : {};
    const builtInDefinitions = buildBuiltInReviewTypeDefinitions();
    const builtInIds = new Set(builtInDefinitions.map((definition) => definition.id));
    const unsafeRequiredIds = Object.entries(requiredReviews)
        .filter(([reviewId, required]) => required === true && !builtInIds.has(reviewId))
        .map(([reviewId]) => reviewId)
        .sort();
    if (unsafeRequiredIds.length > 0) {
        throw new Error(
            'Legacy built-in compatibility cannot authorize custom required review ids: ' +
            unsafeRequiredIds.join(', ') + '.'
        );
    }
    return buildLaneSet(
        'legacy_built_in_compatibility',
        builtInDefinitions.map((definition) => buildContract(
            definition,
            requiredReviews[definition.id] === true ? 'required' : 'optional',
            null
        ))
    );
}

export function resolveEffectiveReviewLaneSet(
    preflight: Record<string, unknown> | null | undefined,
    options: ResolveEffectiveReviewLaneSetOptions = {}
): EffectiveReviewLaneSet {
    const normalizedPreflight = preflight || {};
    if (normalizedPreflight.effective_review_snapshot !== undefined) {
        if (!isPlainRecord(normalizedPreflight.effective_review_snapshot)) {
            throw new Error('Effective review snapshot must be a JSON object.');
        }
        return resolveSnapshotLaneSet(
            normalizedPreflight,
            normalizedPreflight.effective_review_snapshot as unknown as EffectiveReviewSnapshot
        );
    }
    if (options.allowLegacyBuiltInFallback !== true) {
        throw new Error('Immutable effective review snapshot is required for downstream review consumers.');
    }
    return resolveLegacyBuiltInLaneSet(normalizedPreflight);
}

export function resolveEffectiveReviewLaneSetOrLegacy(
    preflight: Record<string, unknown> | null | undefined
): EffectiveReviewLaneSet {
    return resolveEffectiveReviewLaneSet(preflight, { allowLegacyBuiltInFallback: true });
}

export function getEffectiveReviewLaneContract(
    preflight: Record<string, unknown> | null | undefined,
    reviewType: string,
    options: ResolveEffectiveReviewLaneSetOptions = {}
): EffectiveReviewLaneContract {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const laneSet = resolveEffectiveReviewLaneSet(preflight, options);
    const contract = laneSet.lanes.find((lane) => lane.id === normalizedReviewType);
    if (!contract) {
        throw new Error(
            `Review type '${normalizedReviewType || '<missing>'}' is unknown to the effective review lane set.`
        );
    }
    return contract;
}
