import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { writeJsonFile } from '../../../src/core/json';
import {
    loadInitAnswersFile,
    loadManagedConfigFile
} from '../../../src/runtime/loaders';

test('loadInitAnswersFile reads and normalizes persisted init answers', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-node-foundation-'));

    try {
        const targetPath = path.join(tempRoot, 'init-answers.json');
        writeJsonFile(targetPath, {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'GitHubCopilot',
            EnforceNoAutoCommit: '1',
            ClaudeOrchestratorFullAccess: '0',
            TokenEconomyEnabled: 'yes',
            CollectedVia: 'CLI_INTERACTIVE',
            ActiveAgentFiles: 'AGENTS.md'
        });

        const normalized = loadInitAnswersFile(targetPath);
        assert.equal(normalized.SourceOfTruth, 'GitHubCopilot');
        assert.equal(normalized.EnforceNoAutoCommit, true);
        assert.equal(normalized.TokenEconomyEnabled, true);
        assert.deepEqual(normalized.ActiveAgentFiles, ['AGENTS.md']);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('loadManagedConfigFile validates tracked template configs through the runtime loader', () => {
    const normalized = loadManagedConfigFile(
        'paths',
        path.join(process.cwd(), 'template', 'config', 'paths.json')
    );

    assert.ok(Array.isArray(normalized.runtime_roots));
    assert.ok(Array.isArray(((normalized as Record<string, unknown>).triggers as Record<string, unknown>).db));
    assert.ok(normalized.runtime_roots.includes('src/'));
});
