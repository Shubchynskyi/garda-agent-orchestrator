import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    RULE_FILES,
    CONTEXT_RULE_FILES,
    GENERATED_RULE_FILES,
    selectRuleSource,
    applyContextDefaults,
    applyAssistantDefaults,
    generateProjectMemorySummary,
    extractNonEmptySections,
    stripHtmlComments
} from '../../../src/materialization/rule-materialization';

function findRepoRoot() {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'template')) && fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

describe('RULE_FILES', () => {
    it('contains all 12 standard rule files', () => {
        assert.equal(RULE_FILES.length, 12);
        assert.ok(RULE_FILES.includes('00-core.md'));
        assert.ok(RULE_FILES.includes('15-project-memory.md'));
        assert.ok(RULE_FILES.includes('80-task-workflow.md'));
        assert.ok(RULE_FILES.includes('90-skill-catalog.md'));
    });

    it('skill catalogs list all baseline skills used by orchestration', () => {
        const repoRoot = findRepoRoot();
        const requiredSkills = [
            'orchestration',
            'orchestration-depth1',
            'code-review',
            'db-review',
            'dependency-review',
            'security-review',
            'refactor-review',
            'skill-builder'
        ];

        for (const relativePath of [
            'template/docs/agent-rules/90-skill-catalog.md',
            'live/docs/agent-rules/90-skill-catalog.md'
        ]) {
            const fullPath = path.join(repoRoot, relativePath);
            if (!fs.existsSync(fullPath)) {
                continue;
            }
            const content = fs.readFileSync(fullPath, 'utf8');
            for (const skillId of requiredSkills) {
                assert.ok(
                    content.includes(`garda-agent-orchestrator/live/skills/${skillId}`),
                    `${relativePath} should list ${skillId}`
                );
            }
        }
    });
});

describe('GENERATED_RULE_FILES', () => {
    it('contains 15-project-memory.md', () => {
        assert.equal(GENERATED_RULE_FILES.length, 1);
        assert.ok(GENERATED_RULE_FILES.includes('15-project-memory.md'));
    });

    it('is a subset of RULE_FILES', () => {
        for (const f of GENERATED_RULE_FILES) {
            assert.ok(RULE_FILES.includes(f), `${f} should be in RULE_FILES`);
        }
    });
});

describe('CONTEXT_RULE_FILES', () => {
    it('contains the 6 context rules', () => {
        assert.equal(CONTEXT_RULE_FILES.length, 6);
        assert.ok(CONTEXT_RULE_FILES.includes('10-project-context.md'));
        assert.ok(CONTEXT_RULE_FILES.includes('60-operating-rules.md'));
    });
});

describe('selectRuleSource', () => {
    it('prefers template for 00-core.md', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-'));
        try {
            const templateRuleRoot = path.join(tmpDir, 'template');
            const liveRuleRoot = path.join(tmpDir, 'live');
            const targetRoot = path.join(tmpDir, 'project');
            fs.mkdirSync(templateRuleRoot, { recursive: true });
            fs.mkdirSync(liveRuleRoot, { recursive: true });
            fs.mkdirSync(path.join(targetRoot, 'docs/agent-rules'), { recursive: true });
            fs.writeFileSync(path.join(templateRuleRoot, '00-core.md'), 'template');
            fs.writeFileSync(path.join(liveRuleRoot, '00-core.md'), 'live');
            fs.writeFileSync(path.join(targetRoot, 'docs/agent-rules/00-core.md'), 'legacy');

            const result = selectRuleSource('00-core.md', { targetRoot, liveRuleRoot, templateRuleRoot });
            assert.equal(result!.origin, 'template');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers legacy for context rules', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-ctx-'));
        try {
            const templateRuleRoot = path.join(tmpDir, 'template');
            const liveRuleRoot = path.join(tmpDir, 'live');
            const targetRoot = path.join(tmpDir, 'project');
            fs.mkdirSync(templateRuleRoot, { recursive: true });
            fs.mkdirSync(liveRuleRoot, { recursive: true });
            fs.mkdirSync(path.join(targetRoot, 'docs/agent-rules'), { recursive: true });
            fs.writeFileSync(path.join(templateRuleRoot, '10-project-context.md'), 'template');
            fs.writeFileSync(path.join(liveRuleRoot, '10-project-context.md'), 'live');
            fs.writeFileSync(path.join(targetRoot, 'docs/agent-rules/10-project-context.md'), 'legacy');

            const result = selectRuleSource('10-project-context.md', { targetRoot, liveRuleRoot, templateRuleRoot });
            assert.equal(result!.origin, 'legacy-docs');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers live for non-context, non-core rules', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-live-'));
        try {
            const templateRuleRoot = path.join(tmpDir, 'template');
            const liveRuleRoot = path.join(tmpDir, 'live');
            const targetRoot = path.join(tmpDir, 'project');
            fs.mkdirSync(templateRuleRoot, { recursive: true });
            fs.mkdirSync(liveRuleRoot, { recursive: true });
            fs.writeFileSync(path.join(templateRuleRoot, '70-security.md'), 'template');
            fs.writeFileSync(path.join(liveRuleRoot, '70-security.md'), 'live');

            const result = selectRuleSource('70-security.md', { targetRoot, liveRuleRoot, templateRuleRoot });
            assert.equal(result!.origin, 'live-existing');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('returns null when no source found', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-none-'));
        try {
            const result = selectRuleSource('missing.md', {
                targetRoot: tmpDir,
                liveRuleRoot: path.join(tmpDir, 'live'),
                templateRuleRoot: path.join(tmpDir, 'template')
            });
            assert.equal(result, null);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('applyContextDefaults', () => {
    it('appends discovery overlay to context rules', () => {
        const content = '# 10-project-context\n\nSome content.';
        const overlay = '## Project Discovery Snapshot\n- Stacks: Node.js';
        const result = applyContextDefaults(content, '10-project-context.md', overlay);
        assert.ok(result!.includes('Project Discovery Snapshot'));
        assert.ok(result!.includes('Some content'));
    });

    it('does not modify non-context rules', () => {
        const content = '# Security rules\n\nContent.';
        const result = applyContextDefaults(content, '70-security.md', 'overlay');
        assert.equal(result, content);
    });

    it('replaces existing overlay section', () => {
        const content = '# Context\n\n## Project Discovery Snapshot\n- Old data\n\n## Other Section';
        const overlay = '## Project Discovery Snapshot\n- New data';
        const result = applyContextDefaults(content, '10-project-context.md', overlay);
        assert.ok(result!.includes('New data'));
    });
});

describe('applyAssistantDefaults', () => {
    it('replaces placeholders in 00-core.md', () => {
        const content = [
            '{{ASSISTANT_RESPONSE_LANGUAGE}}',
            '{{ASSISTANT_RESPONSE_BREVITY}}',
            'Respond in English for explanations and assistance.',
            '1. Respond in English.',
            'Default response brevity: concise.',
            '2. Keep responses concise unless the user explicitly asks for more or less detail.'
        ].join('\n');

        const result = applyAssistantDefaults(content, '00-core.md', 'Russian', 'detailed');
        assert.ok(result!.includes('Russian'));
        assert.ok(result!.includes('detailed'));
        assert.ok(!result.includes('{{ASSISTANT_RESPONSE_LANGUAGE}}'));
        assert.ok(!result.includes('{{ASSISTANT_RESPONSE_BREVITY}}'));
        assert.ok(result!.includes('Respond in Russian for explanations and assistance.'));
        assert.ok(result!.includes('Default response brevity: detailed.'));
    });

    it('does not modify non-core rules', () => {
        const content = '{{ASSISTANT_RESPONSE_LANGUAGE}}';
        const result = applyAssistantDefaults(content, '10-project-context.md', 'Russian', 'detailed');
        assert.equal(result, content);
    });
});

describe('stripHtmlComments', () => {
    it('removes single-line comments', () => {
        assert.equal(stripHtmlComments('before <!-- comment --> after'), 'before  after');
    });

    it('removes multi-line comments', () => {
        assert.equal(stripHtmlComments('a\n<!-- line1\nline2 -->\nb').trim(), 'a\n\nb');
    });

    it('returns text unchanged when no comments', () => {
        assert.equal(stripHtmlComments('plain text'), 'plain text');
    });
});

describe('extractNonEmptySections', () => {
    it('extracts sections with real content', () => {
        const md = [
            '# Title',
            '',
            '## Domain',
            '',
            'E-commerce platform.',
            '',
            '## Goals',
            '',
            '<!-- placeholder -->',
            ''
        ].join('\n');

        const sections = extractNonEmptySections(md);
        assert.equal(sections.length, 1);
        assert.equal(sections[0].heading, 'Domain');
        assert.equal(sections[0].content, 'E-commerce platform.');
    });

    it('skips sections with only HTML comments', () => {
        const md = '## Empty\n\n<!-- just a hint -->\n\n## Also Empty\n<!-- another -->';
        const sections = extractNonEmptySections(md);
        assert.equal(sections.length, 0);
    });

    it('handles multiple populated sections', () => {
        const md = '## A\nContent A\n## B\nContent B\n';
        const sections = extractNonEmptySections(md);
        assert.equal(sections.length, 2);
        assert.equal(sections[0].heading, 'A');
        assert.equal(sections[1].heading, 'B');
    });
});

describe('generateProjectMemorySummary', () => {
    it('generates stub when directory does not exist', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-absent-'));
        try {
            const result = generateProjectMemorySummary(
                path.join(tmpDir, 'nonexistent'), '2025-01-01T00:00:00.000Z'
            );
            assert.ok(result!.includes('DO NOT EDIT'));
            assert.ok(result!.includes('15 · Project Memory Summary'));
            assert.ok(result!.includes('No `docs/project-memory/` directory found'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('generates stub when directory has no .md files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-empty-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result!.includes('DO NOT EDIT'));
            assert.ok(result!.includes('contains no content files yet'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('generates stub when all files have only placeholder content', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-placeholders-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\n<!-- placeholder -->\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result!.includes('DO NOT EDIT'));
            assert.ok(result!.includes('only placeholder templates'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('generates summary with content and provenance table', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-full-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\nE-commerce SaaS.\n\n## Goals\n\nScale globally.\n', 'utf8');
            fs.writeFileSync(path.join(pmDir, 'stack.md'),
                '# Stack\n\n## Languages\n\nTypeScript 5.x, Python 3.12.\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result!.includes('DO NOT EDIT'));
            assert.ok(result!.includes('2025-01-01T00:00:00.000Z'));
            assert.ok(result!.includes('From `context.md`'));
            assert.ok(result!.includes('### Domain'));
            assert.ok(result!.includes('E-commerce SaaS.'));
            assert.ok(result!.includes('### Goals'));
            assert.ok(result!.includes('Scale globally.'));
            assert.ok(result!.includes('From `stack.md`'));
            assert.ok(result!.includes('### Languages'));
            assert.ok(result!.includes('TypeScript 5.x'));
            // Provenance table
            assert.ok(result!.includes('## Provenance'));
            assert.ok(result!.includes('| Domain | `docs/project-memory/context.md` |'));
            assert.ok(result!.includes('| Goals | `docs/project-memory/context.md` |'));
            assert.ok(result!.includes('| Languages | `docs/project-memory/stack.md` |'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('skips README.md', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-readme-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'README.md'),
                '# Project Memory\n\n## Ownership Contract\n\nUser-owned.\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(!result.includes('Ownership Contract'));
            assert.ok(result!.includes('contains no content files yet'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('regenerates with updated content', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-regen-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\nVersion 1.\n', 'utf8');

            const result1 = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result1.includes('Version 1.'));

            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\nVersion 2.\n', 'utf8');

            const result2 = generateProjectMemorySummary(pmDir, '2025-01-02T00:00:00.000Z');
            assert.ok(result2.includes('Version 2.'));
            assert.ok(!result2.includes('Version 1.'));
            assert.ok(result2.includes('2025-01-02'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('sorts files alphabetically for deterministic output', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-sort-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'z-last.md'),
                '# Z\n\n## Z Section\n\nZ content.\n', 'utf8');
            fs.writeFileSync(path.join(pmDir, 'a-first.md'),
                '# A\n\n## A Section\n\nA content.\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            const aIdx = result.indexOf('From `a-first.md`');
            const zIdx = result.indexOf('From `z-last.md`');
            assert.ok(aIdx < zIdx, 'a-first.md should appear before z-last.md');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
