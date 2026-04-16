import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'AGENT_INIT_PROMPT.md'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

test('AGENT_INIT_PROMPT requires explicit active-agent-files confirmation', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /you must ask the user which agent entrypoint files are actively used/i);
    assert.match(content, /Never silently infer or expand `ActiveAgentFiles`\./);
    assert.match(content, /present supported entrypoint files as explicit ready-made selectable options/i);
    assert.match(content, /QWEN\.md/i);
    assert.match(content, /do not collapse this required question into only `Only <canonical>` plus a generic `Type your answer` fallback/i);
    assert.doesNotMatch(content, /decide yourself whether additional managed entrypoint files are actually needed/i);
});

test('AGENT_INIT_PROMPT avoids duplicate active-agent-files follow-up after step-2 confirmation', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /treat that answer as satisfying the mandatory `ActiveAgentFiles` question in step 3 and do not ask the identical file-list prompt again/i);
    assert.match(content, /Only ask the `ActiveAgentFiles` question in this step if `<active-agent-files>` has not already been explicitly confirmed in step 2\./i);
    assert.match(content, /If step 2 already collected `<active-agent-files>`, reuse that answer here and continue to the next missing mandatory question instead of repeating the same list-selection prompt\./i);
    assert.match(content, /the agent may ask at most one follow-up selection question after `multiple`; once the user has provided the supported file list, do not repeat the identical file-list prompt\./i);
});

test('AGENT_INIT_PROMPT promotes CollectedVia to AGENT_INIT_PROMPT on language or agent-file clarification', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /set `CollectedVia` to `AGENT_INIT_PROMPT\.md` if the agent had to collect one or more missing mandatory answers, clarify `AssistantLanguage`, or ask\/confirm `ActiveAgentFiles`\./);
});

test('AGENT_INIT_PROMPT requires the hard agent-init command before declaring readiness', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /node garda-agent-orchestrator\/bin\/garda\.js agent-init/);
    assert.match(content, /Never declare the workspace ready until `node garda-agent-orchestrator\/bin\/garda\.js agent-init/i);
});

test('AGENT_INIT_PROMPT requires explicit code-style policy for empty repositories', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /ask the user a mandatory code-style policy question/i);
    assert.match(content, /use common best practices instead of copying weak, inconsistent, or legacy code patterns/i);
    assert.match(content, /do not treat inconsistent or obviously low-quality existing code as automatic style source of truth/i);
    assert.match(content, /localized equivalent of `StylePolicy \(answer must be exactly one token: default or custom\):`/i);
    assert.match(content, /localized equivalent of `Choose style-policy for `30-code-style\.md`:`/i);
    assert.match(content, /answer tokens must remain exactly `default` and `custom`/i);
    assert.match(content, /do not ask the style-policy question as the English literal `Choose style-policy for `30-code-style\.md`: default\|custom` unless `<assistant-language>` is English/i);
    assert.match(content, /Present the answer tokens visibly in the prompt as `default\|custom`\./i);
    assert.doesNotMatch(content, /Ask with this exact shape:/i);
    assert.match(content, /The user accepted the default policy for this repository: follow explicit project rules first, formatter\/linter\/static-analysis rules second/i);
});

test('AGENT_INIT_PROMPT distinguishes optional packs from already available skills', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /built-in pack = installable bundle of optional skills/i);
    assert.match(content, /explicitly list baseline skills already available now/i);
    assert.match(content, /recommend only optional packs and optional skills that are not already available/i);
});

test('AGENT_INIT_PROMPT keeps the task execution contract profile-first', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /canonical user command: `Execute task <task-id> from TASK\.md strictly through all mandatory orchestrator gates\.`/i);
    assert.match(content, /active profile is the default execution mode/i);
    assert.match(content, /explicit `depth=<1\|2\|3>` is a one-run override only/i);
    assert.doesNotMatch(content, /default depth when omitted:\s*`2`/i);
});
