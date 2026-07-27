import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
    FullSuiteValidationCycleBinding
} from '../../../../gates/full-suite/full-suite-validation';
import {
    readCompileReadiness
} from '../../../../gates/next-step/next-step-compile-readiness';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import {
    ensureDirectoryExists,
    normalizePathValue,
    parseRequiredText
} from '../../cli-helpers';
import { requireResolvedPath } from '../../shared-command-utils';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';
import {
    runGateFlowPreflightPipelineSync
} from '../support/gate-flow-preflight-pipeline';
import {
    evaluateGateFlowTimelineReadiness,
    resolveGateFlowTimelinePath
} from '../support/gate-flow-runtime';
import {
    readFullSuiteScopeBinding,
    readLatestCompileGatePassedTimestamp
} from './full-suite-validation-cycle-binding';
import type {
    FullSuiteValidationCommandOptions
} from './full-suite-validation-flow-types';

type TaskModeEvidence = ReturnType<typeof getTaskModeEvidence>;

interface FullSuiteValidationParsedPreflight {
    readonly preflightPath: string;
    readonly repoRoot: string;
    readonly taskId: string;
    readonly timelinePath: string;
}

interface FullSuiteValidationLoadedPreflight {
    readonly preflight: Record<string, unknown>;
}

interface FullSuiteValidationTimelineReadiness {
    readonly compileEvidenceCurrent: boolean;
    readonly cycleBinding: FullSuiteValidationCycleBinding;
    readonly timelinePath: string;
    readonly violations: readonly string[];
}

export interface FullSuiteValidationPreflightPipelineOutput
    extends FullSuiteValidationParsedPreflight, FullSuiteValidationLoadedPreflight {
    readonly cycleBinding: FullSuiteValidationCycleBinding;
    readonly taskModeEvidence: TaskModeEvidence;
    readonly timelineReadiness: FullSuiteValidationTimelineReadiness;
}

function normalizeSha256Text(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function readPreflightScopeBinding(
    preflight: Record<string, unknown>
): NonNullable<FullSuiteValidationCycleBinding['scope_binding']> | null {
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const changedFilesSha256 = normalizeSha256Text(metrics.changed_files_sha256);
    const scopeSha256 = normalizeSha256Text(metrics.scope_sha256);
    const scopeContentSha256 = normalizeSha256Text(metrics.scope_content_sha256);
    if (!changedFilesSha256 && !scopeSha256 && !scopeContentSha256) {
        return null;
    }
    return {
        changed_files_sha256: changedFilesSha256,
        scope_sha256: scopeSha256,
        scope_content_sha256: scopeContentSha256
    };
}

export function runFullSuiteValidationPreflightPipeline(
    input: FullSuiteValidationCommandOptions
): FullSuiteValidationPreflightPipelineOutput {
    return runGateFlowPreflightPipelineSync(input, {
        parse(currentInput) {
            const repoRoot = normalizePathValue(currentInput.repoRoot || '.');
            ensureDirectoryExists(repoRoot, 'Repo root');
            const taskId = parseRequiredText(currentInput.taskId, 'TaskId');
            const preflightPath = requireResolvedPath(
                gateHelpers.resolvePathInsideRepo(
                    String(currentInput.preflightPath || ''),
                    repoRoot,
                    { allowMissing: true, enforceInside: false }
                ),
                'PreflightPath'
            );
            if (!gateHelpers.isPathRealpathInsideRoot(preflightPath, repoRoot, { allowMissing: true })) {
                throw new Error(
                    `Preflight path must resolve inside the repository root: ${gateHelpers.normalizePath(preflightPath)}`
                );
            }
            if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
                throw new Error(`Preflight artifact not found: ${gateHelpers.normalizePath(preflightPath)}`);
            }
            if (!gateHelpers.isPathRealpathInsideRoot(preflightPath, repoRoot)) {
                throw new Error(
                    `Preflight path must resolve inside the repository root: ${gateHelpers.normalizePath(preflightPath)}`
                );
            }
            return {
                preflightPath,
                repoRoot,
                taskId,
                timelinePath: gateHelpers.normalizePath(resolveGateFlowTimelinePath(repoRoot, taskId))
            };
        },
        loadTaskModeEvidence({ parsed }) {
            return getTaskModeEvidence(parsed.repoRoot, parsed.taskId);
        },
        loadPreflight({ parsed }) {
            const preflight = JSON.parse(fs.readFileSync(parsed.preflightPath, 'utf8')) as Record<string, unknown>;
            const preflightTaskId = String(preflight.task_id || '').trim();
            if (preflightTaskId && preflightTaskId !== parsed.taskId) {
                throw new Error(
                    `Preflight task_id '${preflightTaskId}' does not match requested task '${parsed.taskId}'.`
                );
            }
            return { preflight };
        },
        evaluateTimelineReadiness({ parsed, preflight }) {
            const orchestratorRoot = resolveOrchestratorRoot(parsed.repoRoot);
            const readiness = evaluateGateFlowTimelineReadiness({
                orchestratorRoot,
                repoRoot: parsed.repoRoot,
                taskId: parsed.taskId,
                timelinePath: parsed.timelinePath,
                requirements: [{
                    eventType: 'COMPILE_GATE_PASSED',
                    recoveryInstruction: 'Run compile-gate before full-suite validation.'
                }]
            });
            const compileReadiness = readCompileReadiness(
                parsed.repoRoot,
                path.join(orchestratorRoot, 'runtime', 'reviews'),
                path.join(orchestratorRoot, 'runtime', 'task-events'),
                parsed.taskId,
                parsed.preflightPath
            );
            const violations = [...readiness.violations];
            if (!compileReadiness.ready) {
                violations.push(`${compileReadiness.reason} Run compile-gate before full-suite validation.`);
            }
            const compileEvidenceCurrent = violations.length === 0;
            return {
                compileEvidenceCurrent,
                timelinePath: parsed.timelinePath,
                violations,
                cycleBinding: {
                    task_id: parsed.taskId,
                    preflight_path: gateHelpers.normalizePath(parsed.preflightPath),
                    preflight_sha256: gateHelpers.fileSha256(parsed.preflightPath) || '',
                    compile_gate_timestamp: compileEvidenceCurrent
                        ? readLatestCompileGatePassedTimestamp(parsed.repoRoot, parsed.taskId)
                        : null,
                    scope_binding: compileEvidenceCurrent
                        ? readFullSuiteScopeBinding(parsed.repoRoot, parsed.taskId, preflight.preflight)
                        : readPreflightScopeBinding(preflight.preflight)
                }
            };
        },
        emit({ parsed, taskModeEvidence, preflight, timelineReadiness }) {
            return {
                ...parsed,
                ...preflight,
                taskModeEvidence,
                cycleBinding: timelineReadiness.cycleBinding,
                timelineReadiness
            };
        }
    });
}
