import { getBundleCliCommand, resolveBundleName } from '../core/constants';

export interface RuleContractSectionMigration {
    liveRelativePath: string;
    templateRelativePath: string;
    heading: string;
    requiredSnippets: readonly string[];
}

let _cachedMigrations: readonly RuleContractSectionMigration[] | null = null;

export function getTaskModeRuleSectionMigrations(): readonly RuleContractSectionMigration[] {
    if (_cachedMigrations) return _cachedMigrations;
    const bn = resolveBundleName();
    _cachedMigrations = Object.freeze([
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/40-commands.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/40-commands.md`,
        heading: '### Compile Gate (Mandatory)',
        requiredSnippets: Object.freeze([
            '### Compile Gate (Mandatory)',
            `${getBundleCliCommand(bn)} gate compile-gate`
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/40-commands.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/40-commands.md`,
        heading: '## Agent Gates',
        requiredSnippets: Object.freeze([
            `${getBundleCliCommand(bn)} gate enter-task-mode`,
            `${getBundleCliCommand(bn)} gate load-rule-pack`,
            '`classify-change` fails without rule-pack evidence',
            'Compile gate additionally validates post-preflight rule-pack evidence',
            '`required-reviews-check` additionally validates post-preflight rule-pack evidence',
            'Compile gate additionally validates explicit task-mode entry evidence from `enter-task-mode`.',
            '`required-reviews-check` additionally validates explicit task-mode entry evidence (`TASK_MODE_ENTERED`) before review pass can succeed.',
            '`build-review-context` before every required reviewer invocation, even when token economy is inactive',
            '`build-review-context` writes `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` automatically for the selected review skill.',
            'ordered lifecycle evidence (`PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `REVIEW_PHASE_STARTED`), real review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`)',
            'Task timeline completeness is surfaced by `status` and `doctor`, not just completion-gate.'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/80-task-workflow.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/80-task-workflow.md`,
        heading: '## Mandatory Gate Contract',
        requiredSnippets: Object.freeze([
            'Task-mode entry command must pass before preflight or implementation:',
            'TASK_MODE_ENTERED',
            'Baseline downstream rules must be opened and recorded before preflight:',
            'RULE_PACK_LOADED',
            'PREFLIGHT_STARTED',
            'IMPLEMENTATION_STARTED',
            'REVIEW_PHASE_STARTED',
            'SKILL_SELECTED',
            'SKILL_REFERENCE_LOADED',
            'After preflight decides `required_reviews.*`, re-run `load-rule-pack --stage "POST_PREFLIGHT" --preflight-path ...`',
            'Compile gate validates post-preflight rule-pack evidence',
            'Review gate command validates task-mode entry evidence (`TASK_MODE_ENTERED`) for the same task id.',
            'Review gate command validates post-preflight rule-pack evidence (`RULE_PACK_LOADED`)',
            'ordered lifecycle evidence (`TASK_MODE_ENTERED`, `RULE_PACK_LOADED`, `PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `COMPILE_GATE_PASSED`, `REVIEW_PHASE_STARTED`, review pass evidence), review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`)',
            'Task timeline completeness is surfaced in `status` and `doctor`',
            'HARD STOP: do not skip `load-rule-pack`',
            'HARD STOP: do not skip `enter-task-mode`',
            'HARD STOP: do not launch required reviewers without `build-review-context`; completion requires review-skill telemetry.'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/90-skill-catalog.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/90-skill-catalog.md`,
        heading: '## Preflight Gate (Mandatory)',
        requiredSnippets: Object.freeze([
            'Before preflight, enter task mode explicitly:',
            `${getBundleCliCommand(bn)} gate enter-task-mode`,
            'record the baseline downstream rules that were actually opened',
            `${getBundleCliCommand(bn)} gate load-rule-pack`,
            'After preflight, re-run `load-rule-pack --stage "POST_PREFLIGHT"`',
            'build-review-context --review-type "<review-type>" --depth "<1|2|3>"'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/90-skill-catalog.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/90-skill-catalog.md`,
        heading: '## Enforcement',
        requiredSnippets: Object.freeze([
            'Missing task-mode entry artifact (`runtime/reviews/<task-id>-task-mode.json`) blocks progression.',
            'Missing rule-pack artifact (`runtime/reviews/<task-id>-rule-pack.json`) blocks progression.',
            'Missing baseline `RULE_PACK_LOADED` blocks preflight.',
            'Missing post-preflight rule-pack proof blocks compile/review/completion.',
            'Missing `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, or `SKILL_REFERENCE_LOADED` blocks completion for code-changing tasks.',
            'Incomplete task timeline evidence is surfaced by `status` and `doctor`.'
        ])
    })
    ]);
    return _cachedMigrations;
}
