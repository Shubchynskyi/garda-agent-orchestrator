import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import { getRulePackEvidence } from '../../../../gates/rule-pack/rule-pack';
import { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import {
    resolvePreflightPath
} from '../../../gate-cli/gates-artifacts';
import {
    runGateFlowPreflightPipeline
} from '../support/gate-flow-preflight-pipeline';
import {
    evaluateGateFlowTimelineReadiness,
    resolveGateFlowTimelinePath
} from '../support/gate-flow-runtime';

type TaskModeEvidence = ReturnType<typeof getTaskModeEvidence>;
type PreflightContext = ReturnType<typeof getPreflightContext>;
type RulePackEvidence = ReturnType<typeof getRulePackEvidence>;
type TimelineReadiness = ReturnType<typeof evaluateGateFlowTimelineReadiness>;

export interface CompileFlowPreflightPipelineInput {
    readonly repoRoot: string;
    readonly orchestratorRoot: string;
    readonly taskId: string;
    readonly taskModePath?: string;
    readonly rulePackPath?: string;
    readonly preflightPath?: string;
    readonly taskModeEvidence: TaskModeEvidence;
}

interface CompileFlowParsedPreflight {
    readonly resolvedPreflightPath: string;
    readonly timelinePath: string;
}

interface CompileFlowLoadedPreflight {
    readonly preflightContext: PreflightContext;
    readonly rulePackEvidence: RulePackEvidence;
}

export interface CompileFlowPreflightPipelineOutput
    extends CompileFlowParsedPreflight, CompileFlowLoadedPreflight {
    readonly taskModeEvidence: TaskModeEvidence;
    readonly timelineReadiness: TimelineReadiness;
}

export async function runCompileFlowPreflightPipeline(
    input: CompileFlowPreflightPipelineInput
): Promise<CompileFlowPreflightPipelineOutput> {
    return runGateFlowPreflightPipeline(input, {
        parse(currentInput) {
            return {
                resolvedPreflightPath: resolvePreflightPath(
                    currentInput.repoRoot,
                    currentInput.preflightPath || '',
                    currentInput.taskId
                ),
                timelinePath: resolveGateFlowTimelinePath(
                    currentInput.repoRoot,
                    currentInput.taskId
                )
            };
        },
        loadTaskModeEvidence({ input: currentInput }) {
            return currentInput.taskModeEvidence;
        },
        loadPreflight({ input: currentInput, parsed }) {
            return {
                preflightContext: getPreflightContext(
                    parsed.resolvedPreflightPath,
                    currentInput.taskId
                ),
                rulePackEvidence: getRulePackEvidence(
                    currentInput.repoRoot,
                    currentInput.taskId,
                    'POST_PREFLIGHT',
                    {
                        artifactPath: currentInput.rulePackPath || '',
                        preflightPath: parsed.resolvedPreflightPath,
                        taskModePath: currentInput.taskModePath || ''
                    }
                )
            };
        },
        evaluateTimelineReadiness({ input: currentInput, parsed }) {
            return evaluateGateFlowTimelineReadiness({
                orchestratorRoot: currentInput.orchestratorRoot,
                repoRoot: currentInput.repoRoot,
                taskId: currentInput.taskId,
                timelinePath: parsed.timelinePath,
                requirements: [
                    {
                        eventType: 'RULE_PACK_LOADED',
                        recoveryInstruction: 'Run load-rule-pack before compile gate.'
                    },
                    {
                        eventType: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        recoveryInstruction: 'Run handshake-diagnostics before compile gate.'
                    },
                    {
                        eventType: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                        recoveryInstruction: 'Run shell-smoke-preflight before compile gate.'
                    }
                ]
            });
        },
        emit({ parsed, taskModeEvidence, preflight, timelineReadiness }) {
            return {
                ...parsed,
                ...preflight,
                taskModeEvidence,
                timelineReadiness
            };
        }
    });
}
