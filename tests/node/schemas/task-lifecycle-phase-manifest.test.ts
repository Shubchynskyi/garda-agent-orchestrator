import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TASK_LIFECYCLE_PHASE_IDS,
    TASK_LIFECYCLE_PHASE_MANIFEST,
    taskLifecyclePhaseManifestSchema,
    validateTaskLifecyclePhaseManifest
} from '../../../src/schemas/task-lifecycle-phase-manifest';
import { validateAgainstSchema } from '../../../src/schemas/config-schemas';

function mutableManifest(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(TASK_LIFECYCLE_PHASE_MANIFEST)) as Record<string, unknown>;
}

test('canonical lifecycle manifest is schema-valid, ordered, and deeply immutable at its owned boundaries', () => {
    const schemaResult = validateAgainstSchema(TASK_LIFECYCLE_PHASE_MANIFEST, taskLifecyclePhaseManifestSchema);
    assert.ok(schemaResult.valid, schemaResult.errors.map((error) => error.message).join('; '));
    assert.deepEqual(TASK_LIFECYCLE_PHASE_MANIFEST.stages.map((stage) => stage.id), TASK_LIFECYCLE_PHASE_IDS);
    assert.ok(Object.isFrozen(TASK_LIFECYCLE_PHASE_MANIFEST));
    assert.ok(Object.isFrozen(TASK_LIFECYCLE_PHASE_MANIFEST.stages));
    assert.ok(TASK_LIFECYCLE_PHASE_MANIFEST.stages.every((stage) => Object.isFrozen(stage.mandatory_gates)));
});

test('canonical lifecycle manifest declares placement-aware mandatory gates without execution commands', () => {
    const validation = TASK_LIFECYCLE_PHASE_MANIFEST.stages.find((stage) => stage.id === 'validation');
    const review = TASK_LIFECYCLE_PHASE_MANIFEST.stages.find((stage) => stage.id === 'review');
    const closeout = TASK_LIFECYCLE_PHASE_MANIFEST.stages.find((stage) => stage.id === 'closeout');
    assert.ok(validation && review && closeout);
    assert.deepEqual(
        validation.mandatory_gates.map((entry) => entry.gate_id),
        ['optional-quality-checklist', 'compile-gate', 'full-suite-validation']
    );
    assert.deepEqual(review.mandatory_gates[0].condition, {
        kind: 'predicate',
        predicate_id: 'full_suite_before_review_checkpoint'
    });
    assert.deepEqual(
        closeout.mandatory_gates.map((entry) => entry.gate_id),
        ['required-reviews-check', 'full-suite-validation', 'project-memory-impact', 'doc-impact-gate']
    );
    assert.doesNotMatch(JSON.stringify(TASK_LIFECYCLE_PHASE_MANIFEST), /(?:node |npm |\.js\b|--repo-root)/u);
});

test('review lifecycle boundary is opaque and does not encode review planning details', () => {
    const review = TASK_LIFECYCLE_PHASE_MANIFEST.stages.find((stage) => stage.id === 'review');
    assert.deepEqual(review?.extension, {
        kind: 'opaque',
        owner: 'review-subsystem',
        contract_id: 'task-review-phase'
    });
    const serialized = JSON.stringify(TASK_LIFECYCLE_PHASE_MANIFEST);
    assert.doesNotMatch(serialized, /review_lane_ids|preparation_order|dependencies|transport/u);

    const candidate = mutableManifest();
    const stages = candidate.stages as Array<Record<string, unknown>>;
    const reviewStage = stages.find((stage) => stage.id === 'review');
    assert.ok(reviewStage);
    reviewStage.extension = {
        kind: 'opaque',
        owner: 'review-subsystem',
        contract_id: 'task-review-phase',
        payload: { subsystem_owned_revision: 2 }
    };
    const normalized = validateTaskLifecyclePhaseManifest(candidate);
    assert.deepEqual(normalized.stages.find((stage) => stage.id === 'review')?.extension?.payload, {
        subsystem_owned_revision: 2
    });
});

test('validator rejects reordered stages and extensions outside the review boundary', () => {
    const reordered = mutableManifest();
    const reorderedStages = reordered.stages as unknown[];
    [reorderedStages[0], reorderedStages[1]] = [reorderedStages[1], reorderedStages[0]];
    assert.throws(
        () => validateTaskLifecyclePhaseManifest(reordered),
        /preserve canonical lifecycle order/u
    );

    const misplaced = mutableManifest();
    const misplacedStages = misplaced.stages as Array<Record<string, unknown>>;
    misplacedStages[0].extension = {
        kind: 'opaque',
        owner: 'review-subsystem',
        contract_id: 'task-review-phase'
    };
    assert.throws(
        () => validateTaskLifecyclePhaseManifest(misplaced),
        /only supported for the review phase/u
    );
});

test('validator rejects unknown lifecycle properties and duplicate semantic ids', () => {
    const unknownProperty = mutableManifest();
    unknownProperty.command = 'node bin/garda.js';
    assert.throws(
        () => validateTaskLifecyclePhaseManifest(unknownProperty),
        /command is not supported/u
    );

    const duplicateCommand = mutableManifest();
    const commands = duplicateCommand.recommended_post_closeout_commands as unknown[];
    commands.push(JSON.parse(JSON.stringify(commands[0])));
    assert.throws(
        () => validateTaskLifecyclePhaseManifest(duplicateCommand),
        /must not contain duplicate command ids/u
    );
});

test('post-closeout recommendations remain semantic and conditional', () => {
    assert.deepEqual(TASK_LIFECYCLE_PHASE_MANIFEST.recommended_post_closeout_commands, [
        {
            command_id: 'task-audit-summary',
            condition: { kind: 'predicate', predicate_id: 'completion_passed' }
        },
        {
            command_id: 'human-commit',
            condition: { kind: 'predicate', predicate_id: 'committable_changes_exist' }
        }
    ]);
});
