import {
    getEffectiveReviewSnapshotViolations,
    type EffectiveReviewSnapshot,
    type EffectiveReviewSnapshotLane
} from '../../policy/effective-review-snapshot';

const MAX_TASK_START_REVIEW_LANES = 9;

export interface NextStepTaskStartSkillGuidance {
    mode: 'direct' | 'catalog';
    suggested_skill_ids: string[];
    activation_commands: string[];
    catalog_path: string | null;
}

export interface NextStepTaskStartReviewLaneGuidance {
    id: string;
    display_label: string;
    selection: 'required' | 'optional' | 'available';
    profile_state: 'disabled' | 'auto' | 'required';
    skill_ids: string[];
}

export interface NextStepTaskStartReviewGuidance {
    mode: 'direct' | 'catalog';
    lanes: NextStepTaskStartReviewLaneGuidance[];
    omitted_lane_count: number;
    catalog_sha256: string;
    advisory_only: true;
}

export interface NextStepTaskStartGuidanceSummary {
    phase: 'pre_implementation';
    skill: NextStepTaskStartSkillGuidance;
    review: NextStepTaskStartReviewGuidance | null;
}

interface OptionalSkillTaskStartInput {
    selection_phase: string;
    selected_skill_ids: string[];
    activation_commands: string[];
    skill_catalog_path: string | null;
}

function toReviewLaneGuidance(
    lane: EffectiveReviewSnapshotLane,
    direct: boolean
): NextStepTaskStartReviewLaneGuidance {
    return {
        id: lane.id,
        display_label: lane.definition.display_label,
        selection: direct && (lane.selection === 'required' || lane.selection === 'optional')
            ? lane.selection
            : 'available',
        profile_state: lane.profile.state,
        skill_ids: [...lane.definition.skill_ids]
    };
}

function buildReviewGuidance(preflight: Record<string, unknown> | null): NextStepTaskStartReviewGuidance | null {
    const snapshotValue = preflight?.effective_review_snapshot;
    if (!snapshotValue || getEffectiveReviewSnapshotViolations(snapshotValue).length > 0) {
        return null;
    }
    const snapshot = snapshotValue as EffectiveReviewSnapshot;
    const selectedLanes = snapshot.lanes.filter((lane) => lane.selection === 'required');
    const direct = selectedLanes.length > 0;
    const relevantLanes = direct
        ? selectedLanes
        : snapshot.lanes.filter((lane) => lane.profile.active);
    const boundedLanes = relevantLanes.slice(0, MAX_TASK_START_REVIEW_LANES);
    return {
        mode: direct ? 'direct' : 'catalog',
        lanes: boundedLanes.map((lane) => toReviewLaneGuidance(lane, direct)),
        omitted_lane_count: Math.max(0, relevantLanes.length - boundedLanes.length),
        catalog_sha256: snapshot.catalog_sha256,
        advisory_only: true
    };
}

export function buildNextStepTaskStartGuidance(input: {
    optionalSkillSelection: OptionalSkillTaskStartInput | null;
    preflight: Record<string, unknown> | null;
}): NextStepTaskStartGuidanceSummary | null {
    const optionalSkills = input.optionalSkillSelection;
    if (!optionalSkills || optionalSkills.selection_phase !== 'pre_implementation') {
        return null;
    }
    const directSkillSuggestion = optionalSkills.selected_skill_ids.length > 0;
    return {
        phase: 'pre_implementation',
        skill: {
            mode: directSkillSuggestion ? 'direct' : 'catalog',
            suggested_skill_ids: [...optionalSkills.selected_skill_ids],
            activation_commands: [...optionalSkills.activation_commands],
            catalog_path: optionalSkills.skill_catalog_path
        },
        review: buildReviewGuidance(input.preflight)
    };
}
