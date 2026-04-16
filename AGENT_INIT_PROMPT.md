# Agent Init Prompt

Read and execute this instruction completely. Do not ask the user to run scripts manually.

## Goal
Create a fully working agent orchestration workspace where canonical rules live only under `garda-agent-orchestrator/live/`, and root entrypoints route to those files.

## Required Execution Flow
1. Confirm working directory is the project root containing `garda-agent-orchestrator/`.
2. Open `garda-agent-orchestrator/runtime/init-answers.json` and determine whether all 6 mandatory answers are already present.
   - If the file already contains all 6 mandatory answers, reuse those answers instead of re-asking everything.
   - If the file already exists and is complete, **reuse all existing answers and do not ask those 6 questions again**.
   - When reusing a complete file, only validate `AssistantLanguage` before continuing:
     - normalize it to a clear agent-readable language label that other agents can understand without guesswork (for example `English`, `Russian`, `Ukrainian`, `German`);
     - if the language answer is ambiguous, typo-heavy, contradictory, or you cannot confidently map it to a single language, ask the user to clarify the language before proceeding;
     - if the language answer is ambiguous, typo-heavy, contradictory, or you cannot confidently map it to a single language, ask the user for a language clarification and do not ask the other setup questions again;
     - write the normalized language value back into `garda-agent-orchestrator/runtime/init-answers.json`.
   - If `ActiveAgentFiles` is missing, empty, or contains only the canonical source-of-truth entrypoint after CLI setup, you must ask the user which agent entrypoint files are actively used in this repository.
     - do not silently infer or expand `ActiveAgentFiles` on the user's behalf;
     - let the user explicitly confirm either canonical-only usage or a broader set such as `CLAUDE.md, AGENTS.md`;
     - present supported entrypoint files as explicit ready-made selectable options, not only as prose inside the question;
     - the visible supported option set must include: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `QWEN.md`, `.github/copilot-instructions.md`, `.windsurf/rules/rules.md`, `.junie/guidelines.md`, and `.antigravity/rules.md`;
     - if the client supports multi-select UI, use it for the supported option set;
     - if the client only supports single-choice plus free-text, ask in two steps:
       1. `Do you use only the canonical file, or multiple agent entrypoint files?`
       2. if the answer is `multiple`, ask again with the full supported option list and allow comma-separated selection;
     - do not collapse this required question into only `Only <canonical>` plus a generic `Type your answer` fallback;
     - treat this active-agent-files confirmation as a required agent-initialization question before the workspace can be considered fully initialized.
     - if this step already collected or explicitly confirmed `<active-agent-files>`, treat that answer as satisfying the mandatory `ActiveAgentFiles` question in step 3 and do not ask the identical file-list prompt again.
   - If the file is missing, invalid, or incomplete, ask only the missing mandatory answers in the exact sequence below while preserving every already valid answer.
3. When questions are required, ask missing mandatory first-run questions in this exact sequence:
   - Ask: `Which language should be used for assistant explanations and help in this project?`
   - Wait for answer and store as `<assistant-language>`.
   - Normalize `<assistant-language>` to a clear agent-readable language label before saving it.
   - If you cannot confidently normalize the answer to one language, ask a clarification question and do not continue until clarified.
   - Immediately switch all subsequent user-facing messages to `<assistant-language>`, starting with the next question.
   - In `<assistant-language>`, ask: `What response brevity should be default: concise or detailed?`
   - Wait for answer and store as `<assistant-brevity>`.
   - Only ask the `ActiveAgentFiles` question in this step if `<active-agent-files>` has not already been explicitly confirmed in step 2.
   - In `<assistant-language>`, ask: `Which agent entrypoint files do you actively use in this project? You may select multiple from CLAUDE.md, AGENTS.md, GEMINI.md, QWEN.md, .github/copilot-instructions.md, .windsurf/rules/rules.md, .junie/guidelines.md, and .antigravity/rules.md. Recommendation: include the agent files you work with most often.`
   - For that question, visibly present the supported files themselves as selectable options; do not leave them hidden only inside the sentence text.
   - If the UI supports multi-select, show the full supported option set directly.
   - If the UI does not support multi-select, first ask whether the user wants `canonical-only` or `multiple active files`, then show the full supported option set and allow comma-separated selection.
   - If step 2 already collected `<active-agent-files>`, reuse that answer here and continue to the next missing mandatory question instead of repeating the same list-selection prompt.
   - Store the answer as `<active-agent-files>`. If the user wants canonical-only usage, save exactly that canonical entrypoint as the explicit answer.
   - In `<assistant-language>`, ask: `Which source-of-truth file should be canonical for rules: Claude (CLAUDE.md), Codex (AGENTS.md), Gemini (GEMINI.md), Qwen (QWEN.md), GitHubCopilot (.github/copilot-instructions.md), Windsurf (.windsurf/rules/rules.md), Junie (.junie/guidelines.md), or Antigravity (.antigravity/rules.md)? All non-selected entrypoint files will redirect to this selected file. Recommendation: choose the agent file you work with most often, ideally from the active files you just selected.`
   - Wait for answer and store as `<source-of-truth>`.
   - In `<assistant-language>`, ask (4th mandatory question): a localized equivalent of `Should the no-auto-commit guard be strengthened? (yes/no)`
   - Wait for answer and store as `<enforce-no-auto-commit>`.
   - In `<assistant-language>`, ask (5th mandatory question): a localized equivalent of `Give Claude full access to orchestrator files? (yes/no)`
   - Wait for answer and store as `<claude-orchestrator-full-access>`.
   - In `<assistant-language>`, ask (6th mandatory question): a localized equivalent of `Enable token-economy mode by default? (yes/no)`
   - Clarify before collecting the answer: this toggle controls reviewer-context compaction for configured depths; shared gate output filtering and fail-tail compaction still apply at any depth.
   - Wait for answer and store as `<token-economy-enabled>`.
   - Hard-stop rule: **if all 6 answers are not collected, do not run installation**.
4. Save required init answers artifact to `garda-agent-orchestrator/runtime/init-answers.json`:
```json
{
  "AssistantLanguage": "<assistant-language>",
  "AssistantBrevity": "<assistant-brevity>",
  "SourceOfTruth": "<source-of-truth>",
  "EnforceNoAutoCommit": "<enforce-no-auto-commit>",
  "ClaudeOrchestratorFullAccess": "<claude-orchestrator-full-access>",
  "TokenEconomyEnabled": "<token-economy-enabled>",
  "CollectedVia": "AGENT_INIT_PROMPT.md"
}
```
If `<active-agent-files>` was collected or explicitly confirmed, also include:
```json
{
  "ActiveAgentFiles": "<active-agent-files>"
}
```
Additional rules for saving:
- if you only reused answers created by CLI setup and made no user-facing clarifications or confirmations at all, preserve the existing `CollectedVia` value (`CLI_INTERACTIVE` or `CLI_NONINTERACTIVE`);
- set `CollectedVia` to `AGENT_INIT_PROMPT.md` if the agent had to collect one or more missing mandatory answers, clarify `AssistantLanguage`, or ask/confirm `ActiveAgentFiles`.
5. Decide whether reinstall is actually needed.
   - If `garda setup` already completed primary initialization and `garda-agent-orchestrator/live/` plus root entrypoints already exist, **do not repeat the 6 questions and do not rerun install just to reapply the same answers**.
   - Run installer only when primary initialization is incomplete, or when missing answers had to be collected and answer-dependent files still need to be materialized/refreshed.
   - If you expand `ActiveAgentFiles` beyond the canonical entrypoint, rerun installer so the additional redirect entrypoints and provider bridge files are materialized.
6. If reinstall is needed, run installer (this also runs init automatically):
```text
node garda-agent-orchestrator/bin/garda.js install --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```
7. Read discovery artifact and update project-context rules for this real project:
    - `garda-agent-orchestrator/live/project-discovery.md`
    - update `10-project-context.md`, `20-architecture.md`, `30-code-style.md`, `40-commands.md`, `60-operating-rules.md` with repository-specific facts.
    - Ask the user a mandatory code-style policy question in `<assistant-language>` before finalizing `30-code-style.md`:
    - Ask this mandatory question in a deterministic format:
      - In `<assistant-language>`, ask a localized equivalent of `StylePolicy (answer must be exactly one token: default or custom):`
      - In `<assistant-language>`, ask a localized equivalent of `Choose style-policy for `30-code-style.md`:`
      - The surrounding question text and option descriptions must follow `<assistant-language>`, but the answer tokens must remain exactly `default` and `custom`.
      - Do not ask the style-policy question as the English literal `Choose style-policy for `30-code-style.md`: default|custom` unless `<assistant-language>` is English.
      - Present the answer tokens visibly in the prompt as `default|custom`.
        - `default`: `explicit project rules` first, `formatter/linter/static-analysis rules` second, and `common best practices` only if both are absent; do not copy weak, inconsistent, or legacy code patterns.
        - `custom`: keep the above priority order but add project-specific style rules now.
      - In `<assistant-language>`, explain the options in deterministic order:
        - `default`: use the repository bootstrap policy
        - `custom`: record repository-specific style rules now
      - If answer is `default`, insert this canonical default paragraph verbatim into `30-code-style.md`:
        - `The user accepted the default policy for this repository: follow explicit project rules first, formatter/linter/static-analysis rules second, and otherwise use common best practices instead of copying weak, inconsistent, or legacy code patterns.`
      - If answer is `custom`, request explicit bullets for project-specific style rules and write them to `30-code-style.md` immediately.
    - do not treat inconsistent or obviously low-quality existing code as automatic style source of truth.
    - tune `garda-agent-orchestrator/live/config/paths.json` when default path roots or trigger regexes do not fit this repository.
8. Finalize agent initialization through the hard code-level gate:
```text
node garda-agent-orchestrator/bin/garda.js agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "<active-agent-files>" --project-rules-updated yes --skills-prompted yes
```
This command is mandatory. It reruns answer-dependent install materialization, runs `verify`, runs manifest validation, and writes `garda-agent-orchestrator/runtime/agent-init-state.json`.
If the command fails, fix the reported issue and rerun it until it prints PASS.
9. Confirm task execution contract is profile-first:
   - canonical user command: `Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.`
   - active profile is the default execution mode
   - explicit `depth=<1|2|3>` is a one-run override only
10. Optional post-init specialization:
   - before the yes/no question, provide in `<assistant-language>`:
     - one-sentence clarification:
       - built-in pack = installable bundle of optional skills;
       - skill = actual `garda-agent-orchestrator/live/skills/<skill-id>/` directory used after installation.
     - `Already configured specialist skills`:
       - run `node garda-agent-orchestrator/bin/garda.js skills list --target-root "."`;
       - explicitly list baseline skills already available now;
       - explicitly list installed built-in optional packs from `garda-agent-orchestrator/live/config/skill-packs.json`;
       - explicitly list installed optional skill directories under `garda-agent-orchestrator/live/skills/**` separately from baseline skills;
       - run `node garda-agent-orchestrator/bin/garda.js skills suggest --target-root "."`;
     - `Available specialist skills to enable/create now`:
       - read only `garda-agent-orchestrator/live/config/skills-index.json` for optional skill discovery;
       - do not open a full optional `SKILL.md` just to decide whether it is relevant;
       - recommend only optional packs and optional skills that are not already available in baseline or already installed;
       - if a pack id overlaps a baseline skill name (for example `security-review`), explicitly label it as an optional pack and state which extra skill directory it would install;
       - recommend built-in packs from `skills list` and optional skills from `skills-index.json` based on the detected stack, task wording, and changed paths;
       - custom specialist skills that can be created via skill-builder.
     - `Recommendation for this project`:
       - provide a short recommended set of built-in packs based on the discovered stack and repository structure.
   - then ask user: `Do you want to add additional specialist skills now? (yes/no)`
   - if `yes`, ask:
     - `Which built-in packs should be added now?`
     - `Do you also want any custom project-specific skills created now?`
   - install built-in packs only through:
     - `node garda-agent-orchestrator/bin/garda.js skills add <pack-id> --target-root "."`
   - after the user selects a built-in pack, install it first; do not read the full optional `SKILL.md` only because the pack was selected;
   - open a full optional `SKILL.md` only later, when the selected skill is actually activated for a task, or when a hard auto-activation rule says it is required;
   - create custom specialist skills only under `garda-agent-orchestrator/live/skills/**` via:
     - `garda-agent-orchestrator/live/skills/skill-builder/SKILL.md`
   - after any built-in or custom skill change, run:
     - `node garda-agent-orchestrator/bin/garda.js skills validate --target-root "."`
     - `node garda-agent-orchestrator/bin/garda.js agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "<active-agent-files>" --project-rules-updated yes --skills-prompted yes`

## Expected State After Success
- Selected source-of-truth entrypoint exists and routes to `garda-agent-orchestrator/live/docs/agent-rules/*`.
- All non-selected entrypoint files redirect to selected source-of-truth entrypoint.
- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md` ... `90-skill-catalog.md` all exist and are non-empty.
- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md` language is configured to user-selected `<assistant-language>`.
- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md` default response brevity is configured to user-selected `<assistant-brevity>`.
- `garda-agent-orchestrator/live/init-report.md` exists.
- `garda-agent-orchestrator/live/project-discovery.md` exists.
- `garda-agent-orchestrator/live/source-inventory.md` exists.
- `garda-agent-orchestrator/live/version.json` exists and matches `garda-agent-orchestrator/VERSION`.
- `garda-agent-orchestrator/live/config/token-economy.json` exists and its `enabled` flag matches `<token-economy-enabled>`.
- if `<enforce-no-auto-commit>` is true: `.git/hooks/pre-commit` contains Garda managed commit guard block.
- `garda-agent-orchestrator/live/config/review-capabilities.json` exists.
- `garda-agent-orchestrator/live/config/paths.json` exists.
- `garda-agent-orchestrator/live/config/skill-packs.json` exists.
- `garda-agent-orchestrator/live/skills/skill-builder/SKILL.md` exists.
- `garda-agent-orchestrator/runtime/agent-init-state.json` exists and matches the finalized onboarding answers.
- `garda-agent-orchestrator/live/USAGE.md` exists with usage instructions in `<assistant-language>`.
- Root `TASK.md` contains `Profile` column in active queue (`default` inherits the workspace active profile).
- Provider-native bridge profiles exist and map back to canonical skills (`.github/agents/*.md`, `.windsurf/agents/orchestrator.md`, `.junie/agents/orchestrator.md`, `.antigravity/agents/orchestrator.md`).
- Copilot bridge profiles include specialist skills added after initialization by re-reading `live/docs/agent-rules/90-skill-catalog.md` and `live/config/review-capabilities.json`.
- Task workflow supports per-task timeline logs at `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`.
- Existing project docs and legacy agent files are not moved or deleted.

## Behavior Requirements
- Read existing project docs and legacy agent files as input context.
- Do not migrate files by moving/removing them.
- Keep changes minimal and deterministic.
- If `runtime/init-answers.json` already exists and is complete, reuse it instead of forcing the user through all 6 questions again.
- After `garda setup`, treat the 6 answers as already collected; the agent must not repeat them unless the file is missing, invalid, incomplete, or `AssistantLanguage` cannot be confidently recognized.
- After `garda setup`, if `ActiveAgentFiles` is still missing, empty, or canonical-only, the agent must explicitly ask the user to confirm which agent entrypoint files are actively used before declaring the workspace ready.
- When asking about `ActiveAgentFiles`, the agent must expose the supported entrypoint files as explicit visible options; it is not acceptable to offer only `Only <canonical>` plus a generic free-text input.
- When the single-choice fallback is used for `ActiveAgentFiles`, the agent may ask at most one follow-up selection question after `multiple`; once the user has provided the supported file list, do not repeat the identical file-list prompt.
- Always validate and normalize `AssistantLanguage` into a clear agent-readable label before saving or re-saving init answers.
- If `AssistantLanguage` cannot be confidently recognized, ask the user for clarification before continuing.
- Never silently infer or expand `ActiveAgentFiles`.
- Never run install before writing `garda-agent-orchestrator/runtime/init-answers.json` with all 6 required answers.
- Do not overwrite `CollectedVia=CLI_INTERACTIVE` or `CLI_NONINTERACTIVE` when you are only reusing CLI-collected answers and normalizing the language field.
- Never declare the workspace ready until `node garda-agent-orchestrator/bin/garda.js agent-init ...` exits PASS.
- Do not modify `garda-agent-orchestrator/AGENT_INIT_PROMPT.md` during project onboarding.
- Update `garda-agent-orchestrator/live/USAGE.md` as part of successful onboarding; that file is expected to become project-specific.
- Never bypass the Node CLI install flow outside this prompt.
- After `<assistant-language>` is collected, continue all following user-facing questions and reports in `<assistant-language>`.
- Treat `node garda-agent-orchestrator/bin/garda.js` as the only canonical runtime surface for lifecycle commands and gates.
- If any check fails, fix the issue and rerun checks until PASS.

## Final Report Format
- What was done.
- Result of each command (PASS or FAIL with key lines).
- Files created or updated.
- `Usage Instructions` section for the user in `<assistant-language>`, with exact next commands for:
  - executing a task (`Execute task <task-id> from TASK.md strictly through all mandatory orchestrator gates.`);
  - using the current active profile (the same command without explicit depth override);
  - using a one-run depth override (`Execute task <task-id> depth=<1|2|3> from TASK.md strictly through all mandatory orchestrator gates.`);
  - when to use `depth=1`, `depth=2`, and `depth=3`.
  - if token economy is enabled, use `depth=1` only for small, well-localized tasks.
  - default `depth=3` keeps full reviewer context while shared gate-output filtering still applies.
  - where tasks are defined: tasks are managed in the root `TASK.md` file.
  - updating orchestrator workspace:
    - `node garda-agent-orchestrator/bin/garda.js check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"`
    - manual apply: `node garda-agent-orchestrator/bin/garda.js update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"`
- Explicit orchestration note:
  - orchestrator mode starts when the agent executes a task from `TASK.md`;
  - if needed, the agent may create new tasks from user requests and then execute them through the orchestrator workflow.
- Save the full `Usage Instructions` section to `garda-agent-orchestrator/live/USAGE.md` so the user can reference it later.
- If optional specialist skills were requested:
  - list added built-in packs and newly created `garda-agent-orchestrator/live/skills/*` paths;
  - list the result of `skills validate`;
  - list any changed capability flags in `review-capabilities.json`.
- If optional specialist skills were not requested:
  - still include the presented `already configured` list, `available` list, and recommendation in the report for traceability.
- Confirmation line: `Workspace ready for task execution` only after `agent-init` passes.

## Constraints
- Do not commit.
- Do not remove unrelated files.
- Do not skip verification.
