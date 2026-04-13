/**
 * Registry of public Node gate commands used by the CLI surface.
 */

export const GATE_COMMANDS = Object.freeze([
    'validate-manifest',
    'enter-task-mode',
    'load-rule-pack',
    'compile-gate',
    'completion-gate',
    'classify-change',
    'build-scoped-diff',
    'build-review-context',
    'doc-impact-gate',
    'required-reviews-check',
    'record-review-routing',
    'record-review-receipt',
    'log-task-event',
    'task-events-summary',
    'human-commit',
    'handshake-diagnostics',
    'shell-smoke-preflight',
    'command-timeout-diagnostics',
    'validate-isolation',
    'prepare-isolation',
    'validate-config'
]);

export function getAllShimmedGateNames() {
    return GATE_COMMANDS.slice();
}
