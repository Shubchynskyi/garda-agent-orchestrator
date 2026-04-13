import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getCanonicalEntrypointForSource,
    serializeInitAnswers,
    validateInitAnswers
} from '../../../src/schemas/init-answers';

import {
    initAnswersSchema,
    validateAgainstSchema
} from '../../../src/schemas/config-schemas';

test('validateInitAnswers normalizes booleans and canonical entrypoint selections', () => {
    const normalized = validateInitAnswers({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'qwen',
        EnforceNoAutoCommit: 'да',
        ClaudeOrchestratorFullAccess: 'no',
        TokenEconomyEnabled: 1,
        CollectedVia: 'cli_noninteractive',
        ActiveAgentFiles: 'QWEN.md, AGENTS.md'
    });

    assert.equal(normalized.EnforceNoAutoCommit, true);
    assert.equal(normalized.ClaudeOrchestratorFullAccess, false);
    assert.equal(normalized.TokenEconomyEnabled, true);
    assert.deepEqual(normalized.ActiveAgentFiles, ['QWEN.md', 'AGENTS.md']);
    assert.equal(getCanonicalEntrypointForSource(normalized.SourceOfTruth), 'QWEN.md');
});

test('serializeInitAnswers returns the persisted string-backed contract shape', () => {
    const serialized = serializeInitAnswers({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: true,
        ClaudeOrchestratorFullAccess: false,
        TokenEconomyEnabled: true,
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 'AGENTS.md, CLAUDE.md'
    });

    assert.equal(serialized.EnforceNoAutoCommit, 'true');
    assert.equal(serialized.ClaudeOrchestratorFullAccess, 'false');
    assert.equal(serialized.TokenEconomyEnabled, 'true');
    assert.equal(serialized.ActiveAgentFiles, 'AGENTS.md, CLAUDE.md');
});

test('validateInitAnswers rejects unsupported source-of-truth values', () => {
    assert.throws(
        () => validateInitAnswers({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Other',
            EnforceNoAutoCommit: true,
            ClaudeOrchestratorFullAccess: false,
            TokenEconomyEnabled: true
        }),
        /SourceOfTruth/
    );
});

// ---------------------------------------------------------------------------
// initAnswersSchema: structure
// ---------------------------------------------------------------------------

test('initAnswersSchema has standard JSON Schema draft-07 metadata', () => {
    assert.equal(initAnswersSchema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(initAnswersSchema.$id, 'garda-agent-orchestrator/init-answers.schema.json');
    assert.equal(initAnswersSchema.title, 'Init Answers');
    assert.equal(initAnswersSchema.type, 'object');
    assert.ok((initAnswersSchema.description as string).length > 0);
});

test('initAnswersSchema declares all required properties', () => {
    const required = initAnswersSchema.required as string[];
    for (const key of [
        'AssistantLanguage', 'AssistantBrevity', 'SourceOfTruth',
        'EnforceNoAutoCommit', 'ClaudeOrchestratorFullAccess', 'TokenEconomyEnabled',
        'CollectedVia'
    ]) {
        assert.ok(required.includes(key), `${key} should be required`);
    }
    assert.ok(!required.includes('ActiveAgentFiles'), 'ActiveAgentFiles should be optional');
});

test('initAnswersSchema disallows additional properties', () => {
    assert.equal(initAnswersSchema.additionalProperties, false);
});

// ---------------------------------------------------------------------------
// initAnswersSchema: valid documents
// ---------------------------------------------------------------------------

test('serialized init-answers validates against initAnswersSchema', () => {
    const serialized = serializeInitAnswers({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: true,
        ClaudeOrchestratorFullAccess: false,
        TokenEconomyEnabled: true,
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 'AGENTS.md, CLAUDE.md'
    });

    const result = validateAgainstSchema(serialized, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, true, `Unexpected errors: ${JSON.stringify(result.errors)}`);
});

test('serialized init-answers without ActiveAgentFiles validates against initAnswersSchema', () => {
    const serialized = serializeInitAnswers({
        AssistantLanguage: 'English',
        AssistantBrevity: 'detailed',
        SourceOfTruth: 'GitHubCopilot',
        EnforceNoAutoCommit: false,
        ClaudeOrchestratorFullAccess: true,
        TokenEconomyEnabled: false,
        CollectedVia: 'CLI_INTERACTIVE'
    });

    const result = validateAgainstSchema(serialized, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, true, `Unexpected errors: ${JSON.stringify(result.errors)}`);
});

test('all SourceOfTruth enum values pass schema validation', () => {
    const sourceValues = ['Claude', 'Codex', 'Gemini', 'Qwen', 'GitHubCopilot', 'Windsurf', 'Junie', 'Antigravity'];
    for (const source of sourceValues) {
        const doc = {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: source,
            EnforceNoAutoCommit: 'true',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md'
        };
        const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
        assert.equal(result.valid, true, `SourceOfTruth '${source}' should be valid: ${JSON.stringify(result.errors)}`);
    }
});

// ---------------------------------------------------------------------------
// initAnswersSchema: invalid documents
// ---------------------------------------------------------------------------

test('initAnswersSchema rejects missing required properties', () => {
    const result = validateAgainstSchema({}, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 7);
});

test('initAnswersSchema rejects invalid SourceOfTruth enum value', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Unknown',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md'
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('SourceOfTruth')));
});

test('initAnswersSchema rejects invalid AssistantBrevity enum value', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'verbose',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md'
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('AssistantBrevity')));
});

test('initAnswersSchema rejects additional properties', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        UnknownField: 'surprise'
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.message.includes("Additional property 'UnknownField'")));
});

test('initAnswersSchema rejects invalid CollectedVia enum value', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'UNKNOWN'
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('CollectedVia')));
});

test('initAnswersSchema rejects invalid boolean-like string', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'yes',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md'
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('EnforceNoAutoCommit')));
});

test('initAnswersSchema rejects invalid ClaudeOrchestratorFullAccess value', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'maybe',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md'
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('ClaudeOrchestratorFullAccess')));
});

test('initAnswersSchema rejects invalid TokenEconomyEnabled value', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'on',
        CollectedVia: 'AGENT_INIT_PROMPT.md'
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('TokenEconomyEnabled')));
});

test('initAnswersSchema rejects empty AssistantLanguage', () => {
    const doc = {
        AssistantLanguage: '',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md'
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('AssistantLanguage')));
});

test('initAnswersSchema rejects non-string ActiveAgentFiles', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 42
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('ActiveAgentFiles')));
});

test('initAnswersSchema rejects empty-string ActiveAgentFiles', () => {
    const doc = {
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: ''
    };
    const result = validateAgainstSchema(doc, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('ActiveAgentFiles')));
});

test('live runtime init-answers.json validates against initAnswersSchema when present', () => {
    const fs = require('node:fs');
    const path = require('node:path');

    let repoRoot = process.cwd();
    if (!fs.existsSync(path.join(repoRoot, 'package.json'))) {
        repoRoot = path.resolve(__dirname, '..', '..', '..');
    }

    const liveAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(liveAnswersPath)) {
        return;
    }

    const raw = JSON.parse(fs.readFileSync(liveAnswersPath, 'utf8'));
    const result = validateAgainstSchema(raw, initAnswersSchema as Record<string, unknown>);
    assert.equal(result.valid, true, `Live init-answers.json failed schema: ${JSON.stringify(result.errors)}`);
});
