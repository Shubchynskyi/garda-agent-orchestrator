import test from 'node:test';
import assert from 'node:assert/strict';

import { compileReviewDependencyGraph } from '../../../../../../src/core/review-dependency-graph';
import {
    assertPrepareReviewerLaunchDependencyReadiness
} from '../../../../../../src/cli/commands/gate-review-handlers/launch/review-launch-prepare-handler';

test('prepare-reviewer-launch independently rejects a graph-blocked downstream lane', () => {
    const dependencyGraph = compileReviewDependencyGraph({
        catalogLaneIds: ['code', 'security'],
        activeLaneIds: ['code', 'security'],
        requiredReviewIds: ['code', 'security'],
        mode: 'parallel_all',
        declaration: {
            preparation_order: ['security', 'code'],
            dependencies: {
                security: [],
                code: ['security']
            }
        }
    });
    const preflightPayload = {
        task_id: 'T-729-5B',
        required_reviews: {
            code: true,
            security: true
        },
        review_execution_policy: {
            mode: 'parallel_all',
            dependency_graph: dependencyGraph
        },
        effective_review_snapshot: {
            review_dependency_graph: dependencyGraph
        }
    };

    assert.throws(
        () => assertPrepareReviewerLaunchDependencyReadiness({
            taskId: 'T-729-5B',
            preflightPath: 'D:/repo/garda-agent-orchestrator/runtime/reviews/T-729-5B-preflight.json',
            preflightPayload,
            reviewType: 'code',
            timelineEvents: [{
                event_type: 'COMPILE_GATE_PASSED',
                sequence: 1,
                details: null
            }]
        }),
        /ReviewType 'code' is blocked until upstream reviews pass.*security.*DependencyPolicy: parallel_all/u
    );
});

test('prepare-reviewer-launch permits an independent lane in the same compiled graph', () => {
    const dependencyGraph = compileReviewDependencyGraph({
        catalogLaneIds: ['code', 'security'],
        activeLaneIds: ['code', 'security'],
        requiredReviewIds: ['code', 'security'],
        mode: 'parallel_all',
        declaration: {
            preparation_order: ['security', 'code'],
            dependencies: {
                security: [],
                code: ['security']
            }
        }
    });
    const preflightPayload = {
        task_id: 'T-729-5B',
        required_reviews: {
            code: true,
            security: true
        },
        review_execution_policy: {
            mode: 'parallel_all',
            dependency_graph: dependencyGraph
        },
        effective_review_snapshot: {
            review_dependency_graph: dependencyGraph
        }
    };

    assert.doesNotThrow(() => assertPrepareReviewerLaunchDependencyReadiness({
        taskId: 'T-729-5B',
        preflightPath: 'D:/repo/garda-agent-orchestrator/runtime/reviews/T-729-5B-preflight.json',
        preflightPayload,
        reviewType: 'security',
        timelineEvents: [{
            event_type: 'COMPILE_GATE_PASSED',
            sequence: 1,
            details: null
        }]
    }));
});
