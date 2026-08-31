import {
    TASK_LIFECYCLE_PHASE_MANIFEST,
    type TaskLifecycleCondition,
    type TaskLifecyclePhaseId,
    type TaskLifecyclePhaseManifest,
    type TaskLifecyclePredicateId
} from '../schemas/task-lifecycle-phase-manifest';

export type TaskLifecyclePredicateValues = Readonly<
    Partial<Record<TaskLifecyclePredicateId, boolean>>
>;

export function isTaskLifecycleConditionActive(
    condition: TaskLifecycleCondition,
    predicates: TaskLifecyclePredicateValues
): boolean {
    return condition.kind === 'always' || predicates[condition.predicate_id] === true;
}

export function getActiveTaskLifecycleGateIds(
    phaseId: TaskLifecyclePhaseId,
    predicates: TaskLifecyclePredicateValues,
    manifest: TaskLifecyclePhaseManifest = TASK_LIFECYCLE_PHASE_MANIFEST
): readonly string[] {
    const phase = manifest.stages.find((candidate) => candidate.id === phaseId);
    if (!phase) {
        throw new Error(`Lifecycle manifest is missing canonical phase '${phaseId}'.`);
    }
    if (!isTaskLifecycleConditionActive(phase.condition, predicates)) {
        return Object.freeze([]);
    }
    return Object.freeze(
        phase.mandatory_gates
            .filter((entry) => isTaskLifecycleConditionActive(entry.condition, predicates))
            .map((entry) => entry.gate_id)
    );
}

export function resolveFirstActiveTaskLifecycleGate<T>(
    gateIds: readonly string[],
    resolvers: Readonly<Record<string, () => T | null>>
): T | null {
    for (const gateId of gateIds) {
        const resolver = resolvers[gateId];
        if (!resolver) {
            throw new Error(`No runtime resolver is registered for active lifecycle gate '${gateId}'.`);
        }
        const result = resolver();
        if (result !== null) {
            return result;
        }
    }
    return null;
}
