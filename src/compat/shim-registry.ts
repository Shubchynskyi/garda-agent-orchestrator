const SHIMMED_GATE_NAME_VALUES = [
    'validate-manifest',
    'enter-task-mode',
    'restart-coherent-cycle',
    'restart-review-cycle',
    'load-rule-pack',
    'bind-rule-pack-to-preflight',
    'record-no-op',
    'compile-gate',
    'full-suite-validation',
    'completion-gate',
    'classify-change',
    'build-scoped-diff',
    'build-review-context',
    'activate-optional-skill',
    'doc-impact-gate',
    'required-reviews-check',
    'record-review-result',
    'record-review-routing',
    'prepare-reviewer-launch',
    'complete-reviewer-launch',
    'record-review-invocation',
    'record-review-receipt',
    'log-task-event',
    'task-events-summary',
    'task-audit-summary',
    'next-step',
    'human-commit',
    'handshake-diagnostics',
    'shell-smoke-preflight',
    'command-timeout-diagnostics',
    'project-memory-impact',
    'validate-isolation',
    'prepare-isolation',
    'task-reset',
    'validate-config'
] as const;

export type ShimmedGateName = (typeof SHIMMED_GATE_NAME_VALUES)[number];

export const GATE_COMMANDS = Object.freeze<readonly string[]>([...SHIMMED_GATE_NAME_VALUES]);

export function getAllShimmedGateNames(): string[] {
    return [...GATE_COMMANDS];
}
