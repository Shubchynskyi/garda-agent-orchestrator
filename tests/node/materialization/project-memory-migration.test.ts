import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    countMeaningfulAddedLines,
    extractMigrationContent,
    getMeaningfulLines,
    isProjectMemoryOnlySeeds,
    MEANINGFUL_DIFF_THRESHOLD,
    migrateContextRulesToProjectMemory,
    MIGRATION_MARKER,
    MIGRATION_RULE_MAP,
    buildMigrationReportLines
} from '../../../src/materialization/project-memory-migration';
import { runInit } from '../../../src/materialization/init';

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function setupTestWorkspace(bundleRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-mig-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });
    fs.copyFileSync(path.join(bundleRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    copyDirRecursive(path.join(bundleRoot, 'template'), path.join(bundle, 'template'));
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live'), { recursive: true });
    return { projectRoot: tmpDir, bundleRoot: bundle };
}

function copyDirRecursive(src: string, dst: string) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

const TEMPLATE_10 = fs.readFileSync(
    path.join(findRepoRoot(), 'template/docs/agent-rules/10-project-context.md'), 'utf8'
);

const USER_AUTHORED_10 = `# Project Context

## Purpose
Define project-specific context for this repository.

## Project Summary
We build an advanced e-commerce platform for luxury goods.
The system handles inventory management, order processing,
and real-time analytics for 50+ retail locations worldwide.
Our primary users are warehouse operators and store managers.

## Confirmed Technology Baseline
- TypeScript 5.4 with strict mode
- Node.js 20 LTS with ESM modules
- PostgreSQL 16 with pgvector extension
- Redis 7 for caching and pub/sub
- Docker Compose for local development
- Kubernetes (EKS) for production

## Architecture
Modular monolith with event-driven communication between bounded contexts.
The system consists of five main modules: catalog, inventory, orders,
analytics, and notifications. Each module owns its data and exposes
well-defined APIs to other modules.
`;

const TEMPLATE_20 = fs.readFileSync(
    path.join(findRepoRoot(), 'template/docs/agent-rules/20-architecture.md'), 'utf8'
);

const TEMPLATE_30 = fs.readFileSync(
    path.join(findRepoRoot(), 'template/docs/agent-rules/30-code-style.md'), 'utf8'
);

const USER_AUTHORED_20 = `# Architecture

## System Shape (Required)
- Architecture style: modular monolith with event bus
- Deployable units: single Node.js process (dev), Docker container (prod)
- Runtime boundaries: five bounded contexts sharing a process

## Source Layout Snapshot
\`\`\`text
ecommerce-platform/
├── src/catalog/
├── src/inventory/
├── src/orders/
├── src/analytics/
├── src/notifications/
├── src/shared/
└── infrastructure/
\`\`\`

## Data and Control Flow (Required)
- Entry points: REST API (Express), WebSocket (analytics dashboard)
- Main request flow: API gateway -> router -> module handler -> repository -> DB
- Persistence: PostgreSQL per-module schema, Redis for sessions
- External integrations: Stripe payments, SendGrid email, Datadog APM

## Architecture Risk Areas
- State consistency: eventual consistency between modules via event bus
- Security: JWT auth with RBAC, API rate limiting per tenant
- Failure: circuit breaker pattern for external service calls
- Performance: hot path is order creation (P99 target: 200ms)
`;

const LEGACY_DEFAULT_30 = `# Code Style

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Purpose
Define style rules for languages that actually exist in this repository.

## Global Rules
- Prefer small, testable functions and explicit naming.
- Keep public APIs stable and documented.
- Follow explicit project rules first, not vague habit or local drift.
- If formatter or linter exists, treat it as source of truth.
- Do not copy inconsistent, legacy, or obviously low-quality patterns just because they already exist in the repository.

## Style Priority Order
- Rules written in this file are the primary source of truth.
- Formatter, linter, and static-analysis configs come next.
- Strong, consistent patterns from high-quality project modules may refine local style decisions.
- Common best practices are the fallback when project-specific guidance is missing.

## Bootstrap Policy When Repository Is Empty
- If there is little or no real project code yet, do not invent a silent style policy.
- Ask the user a mandatory question: accept the default policy of explicit rules + tooling + common best practices, or provide custom project-specific style rules now.
- Record that answer here before broad implementation starts.
- If the default policy is accepted, state it explicitly instead of leaving the section vague.
- As soon as stable project-specific rules exist, replace this bootstrap policy with concrete repository-specific guidance.

## Language-Specific Rules (Fill Only Relevant Sections)

### Java or Kotlin (if present)
- DTO and domain mapping style: \`TODO\`
- Null-safety and error handling approach: \`TODO\`
- Transaction and persistence conventions: \`TODO\`

### TypeScript or JavaScript (if present)
- Type strictness level and runtime validation strategy: \`TODO\`
- Component and state management conventions: \`TODO\`
- API contract and schema handling: \`TODO\`

### Python (if present)
- Type hinting policy and linting rules: \`TODO\`
- Async patterns and dependency management: \`TODO\`
- Framework-specific conventions: \`TODO\`

### Go (if present)
- Package boundaries and interface patterns: \`TODO\`
- Error wrapping and logging rules: \`TODO\`

### Rust (if present)
- Ownership and error handling conventions: \`TODO\`
- Module and crate organization rules: \`TODO\`

## Definition of Done for Style
- Rules above must match actual stack from \`live/project-discovery.md\`.
- Outdated language sections must be removed or explicitly marked as not applicable.
`;

const LEGACY_CUSTOMIZED_30 = `${LEGACY_DEFAULT_30}

## Project TypeScript Conventions
- Prefer explicit runtime validation for persisted JSON artifacts.
- Keep serializer boundary fields in snake_case and internal helper state in camelCase.
- Put shared CLI formatter helpers in dedicated modules instead of inline command handlers.
- Keep handler modules thin: parse -> validate -> execute -> render.
- Preserve rationale-only comments for provider quirks and invariants.
- Prefer intent-first helper names such as resolve*, build*, and format*.
`;

const LEGACY_BRIDGED_30 = `${LEGACY_DEFAULT_30}

## Comments
- Keep comments only for rationale, invariants, security-sensitive constraints,
  provider or platform quirks, or real boundary exceptions.
- Remove section banners, step narration, line-by-line paraphrases, and JSDoc
  for self-explanatory typed helpers.
- If a block is understandable only because of a prose comment, simplify the
  code first.

## Naming
- Internal code uses \`camelCase\`.
- Type-like symbols use \`PascalCase\`.
- Do not prefix interfaces with \`I\`.
- Boolean helpers should read like questions: \`is*\`, \`has*\`, \`can*\`,
  \`should*\`.
- Prefer intent-first helper names such as \`resolve*\`, \`read*\`, \`parse*\`,
  \`build*\`, \`format*\`, and \`print*\`.
`;

const LEGACY_MINIMAL_CUSTOMIZED_30 = `${LEGACY_DEFAULT_30}

## Team Conventions
- Prefer domain event names that read like past-tense business facts.
`;

const LEGACY_WRAPPED_CUSTOMIZED_30 = `${LEGACY_DEFAULT_30}

## Team Conventions
- Preserve multiline migration notes when a custom rule needs additional
  context on the next line for maintainers reading generated conventions.
`;

const LEGACY_INDENTED_CONTINUATION_30 = TEMPLATE_30.replace(
    /- Prefer intent-first helper names such as `resolve\*`, `read\*`, `parse\*`,\r?\n  `build\*`, `format\*`, and `print\*`\./,
    '- Prefer intent-first helper names such as `resolve*`, `read*`, `parse*`,\n  `build*`, `format*`, and `print*`.\n  Keep transport adapters suffixed with `Gateway` so boundary wiring stays obvious.'
);

// ──────────────────────────────────────────────────
// Unit tests for detection helpers
// ──────────────────────────────────────────────────

describe('getMeaningfulLines', () => {
    it('strips HTML comments and empty lines', () => {
        const text = '# Heading\n\n<!-- comment -->\n\nReal content here.\n';
        const lines = getMeaningfulLines(text);
        assert.ok(!lines.some(l => l.includes('comment')));
        assert.ok(lines.includes('Real content here.'));
    });

    it('strips Project Discovery Snapshot section', () => {
        const text = '## Foo\nfoo content\n\n## Project Discovery Snapshot\ngenerated stuff\nmore generated\n\n## Bar\nbar content\n';
        const lines = getMeaningfulLines(text);
        assert.ok(!lines.some(l => l.includes('generated')));
        assert.ok(lines.includes('foo content'));
        assert.ok(lines.includes('bar content'));
    });

    it('excludes headings, code fences, table separators, and TODO markers', () => {
        const text = '## Section\n```bash\nnpm test\n```\n|---|---|\nTODO\n`TODO`\n---\nReal line\n';
        const lines = getMeaningfulLines(text);
        assert.ok(!lines.includes('```bash'));
        assert.ok(!lines.includes('```'));
        assert.ok(!lines.includes('TODO'));
        assert.ok(!lines.includes('`TODO`'));
        assert.ok(!lines.includes('---'));
        assert.ok(lines.includes('npm test'));
        assert.ok(lines.includes('Real line'));
    });
});

describe('countMeaningfulAddedLines', () => {
    it('returns 0 for identical content', () => {
        assert.equal(countMeaningfulAddedLines(TEMPLATE_10, TEMPLATE_10), 0);
    });

    it('detects added lines in user-authored content', () => {
        const count = countMeaningfulAddedLines(USER_AUTHORED_10, TEMPLATE_10);
        assert.ok(count > MEANINGFUL_DIFF_THRESHOLD,
            `Expected >${MEANINGFUL_DIFF_THRESHOLD} added lines, got ${count}`);
    });

    it('returns low count for minor template tweaks', () => {
        const tweaked = TEMPLATE_10.replace('TODO', 'monolith') + '\n<!-- minor -->\n';
        const count = countMeaningfulAddedLines(tweaked, TEMPLATE_10);
        assert.ok(count <= MEANINGFUL_DIFF_THRESHOLD,
            `Expected ≤${MEANINGFUL_DIFF_THRESHOLD} for minor tweak, got ${count}`);
    });
});

describe('isProjectMemoryOnlySeeds', () => {
    const repoRoot = findRepoRoot();

    it('returns true for template-seeded directory', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);
            assert.equal(isProjectMemoryOnlySeeds(pmDir), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('returns false when a file has real content', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Project Context\n\n## Domain\n\nB2B logistics SaaS.\n');
            assert.equal(isProjectMemoryOnlySeeds(pmDir), false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('returns true for empty directory', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            assert.equal(isProjectMemoryOnlySeeds(pmDir), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

describe('extractMigrationContent', () => {
    it('removes Purpose and Project Discovery Snapshot sections', () => {
        const input = [
            '# Architecture',
            '',
            '## Purpose',
            'Describe actual runtime architecture.',
            '',
            '## System Shape',
            'modular monolith',
            '',
            '## Project Discovery Snapshot',
            'auto-generated signals',
            ''
        ].join('\n');

        const output = extractMigrationContent(input, 'Architecture');
        assert.ok(!output.includes('## Purpose'));
        assert.ok(!output.includes('Describe actual runtime'));
        assert.ok(!output.includes('Project Discovery Snapshot'));
        assert.ok(!output.includes('auto-generated'));
        assert.ok(output.includes('## System Shape'));
        assert.ok(output.includes('modular monolith'));
    });

    it('uses the target heading for the H1', () => {
        const output = extractMigrationContent('# Code Style\n\n## Naming\nkebab-case\n', 'Conventions');
        assert.ok(output.startsWith('# Conventions'));
        assert.ok(!output.includes('# Code Style'));
    });

    it('includes migration provenance comment', () => {
        const output = extractMigrationContent('# Arch\n\n## Shape\nmonolith\n', 'Architecture');
        assert.ok(output.includes('Migrated from agent-rules'));
    });

    it('returns empty string when only boilerplate sections remain', () => {
        const input = '# Context\n\n## Purpose\nTemplate text.\n\n## Project Discovery Snapshot\ngenerated\n';
        const output = extractMigrationContent(input, 'Project Context');
        assert.equal(output, '');
    });

    it('drops sections whose body is only HTML comments', () => {
        const input = '# Context\n\n## Domain\n<!-- placeholder -->\n\n## Goals\nReal goal here.\n';
        const output = extractMigrationContent(input, 'Project Context');
        assert.ok(!output.includes('## Domain'));
        assert.ok(output.includes('## Goals'));
        assert.ok(output.includes('Real goal here.'));
    });

    it('keeps only novel legacy code-style refinements when migrating conventions', () => {
        const output = extractMigrationContent(LEGACY_CUSTOMIZED_30, 'Conventions', {
            ruleFile: '30-code-style.md',
            templateContent: TEMPLATE_30
        });

        assert.ok(output.includes('## Project TypeScript Conventions'));
        assert.ok(output.includes('Prefer explicit runtime validation for persisted JSON artifacts.'));
        assert.ok(!output.includes('## Bootstrap Policy When Repository Is Empty'));
        assert.ok(!output.includes('## Language-Specific Rules (Fill Only Relevant Sections)'));
        assert.ok(!output.includes('## Global Rules'));
        assert.ok(!output.includes('## Style Priority Order'));
    });

    it('preserves wrapped custom bullet indentation for legacy code-style refinements', () => {
        const output = extractMigrationContent(LEGACY_WRAPPED_CUSTOMIZED_30, 'Conventions', {
            ruleFile: '30-code-style.md',
            templateContent: TEMPLATE_30
        });

        assert.ok(output.includes('## Team Conventions'));
        assert.ok(output.includes('- Preserve multiline migration notes when a custom rule needs additional'));
        assert.ok(output.includes('  context on the next line for maintainers reading generated conventions.'));
    });

    it('preserves the parent bullet when a novel refinement is an indented continuation under a template bullet', () => {
        const output = extractMigrationContent(LEGACY_INDENTED_CONTINUATION_30, 'Conventions', {
            ruleFile: '30-code-style.md',
            templateContent: TEMPLATE_30
        });

        assert.ok(output.includes('## Naming'));
        assert.ok(output.includes('- Prefer intent-first helper names such as `resolve*`, `read*`, `parse*`,'));
        assert.ok(output.includes('  Keep transport adapters suffixed with `Gateway` so boundary wiring stays obvious.'));
    });
});

// ──────────────────────────────────────────────────
// Integration tests via migrateContextRulesToProjectMemory
// ──────────────────────────────────────────────────

describe('migrateContextRulesToProjectMemory', () => {
    const repoRoot = findRepoRoot();

    it('skips when marker file exists (T-075 idempotency)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);
            const markerPath = path.join(pmDir, MIGRATION_MARKER);
            fs.writeFileSync(markerPath, 'already done\n', 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'already_migrated');
            assert.equal(result.migratedFiles.length, 0);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('skips when project-memory dir does not exist', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'no_project_memory_dir');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('skips when project-memory already has user content', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Project Context\n\n## Domain\n\nReal project description.\n');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'project_memory_has_content');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates user-authored content from legacy context rules (T-075)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // Seed project-memory with templates
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            // Place user-authored legacy rule
            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '10-project-context.md'), USER_AUTHORED_10, 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'migrated');
            assert.ok(result.migratedFiles.length >= 1);

            const migrated10 = result.migratedFiles.find(f => f.ruleFile === '10-project-context.md');
            assert.ok(migrated10, '10-project-context.md should be migrated');
            assert.equal(migrated10.memoryFile, 'context.md');
            assert.equal(migrated10.origin, 'legacy-docs');

            // Verify content was written
            const contextContent = fs.readFileSync(path.join(pmDir, 'context.md'), 'utf8');
            assert.ok(contextContent.includes('e-commerce platform'), 'migrated content must be present');
            assert.ok(contextContent.includes('Migrated from agent-rules'), 'provenance comment must be present');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates from live-existing context rules (T-075)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // Seed project-memory with templates
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            // Place user-authored live rule (simulating previous edit)
            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '20-architecture.md'), USER_AUTHORED_20, 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'migrated');
            const migrated20 = result.migratedFiles.find(f => f.ruleFile === '20-architecture.md');
            assert.ok(migrated20, '20-architecture.md should be migrated');
            assert.equal(migrated20.memoryFile, 'architecture.md');

            const archContent = fs.readFileSync(path.join(pmDir, 'architecture.md'), 'utf8');
            assert.ok(archContent.includes('modular monolith'));
            assert.ok(archContent.includes('bounded contexts'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('writes marker file after migration (T-075)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '10-project-context.md'), USER_AUTHORED_10, 'utf8');

            migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            const markerPath = path.join(pmDir, MIGRATION_MARKER);
            assert.ok(fs.existsSync(markerPath), 'marker file must exist after migration');
            const markerContent = fs.readFileSync(markerPath, 'utf8');
            assert.ok(markerContent.includes('migrated_at:'));
            assert.ok(markerContent.includes('10-project-context.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('writes marker even when no rules qualify for migration (T-075)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            // No legacy or live rules — all sources are template
            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'no_significant_content');
            assert.ok(fs.existsSync(path.join(pmDir, MIGRATION_MARKER)),
                'marker file must be written even when nothing migrated');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not overwrite in dryRun mode', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '10-project-context.md'), USER_AUTHORED_10, 'utf8');

            const originalContext = fs.readFileSync(path.join(pmDir, 'context.md'), 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template'),
                dryRun: true
            });

            assert.equal(result.status, 'migrated');
            assert.ok(!fs.existsSync(path.join(pmDir, MIGRATION_MARKER)));
            assert.equal(fs.readFileSync(path.join(pmDir, 'context.md'), 'utf8'), originalContext);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not migrate rules with minimal template tweaks (T-075)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            // Place a lightly tweaked rule (≤5 meaningful added lines)
            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            const tweakedTemplate = TEMPLATE_20
                .replace('`TODO`', 'microservices')
                .replace('`TODO`', 'two services');
            fs.writeFileSync(path.join(liveRuleDir, '20-architecture.md'), tweakedTemplate, 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            const migrated20 = result.migratedFiles.find(f => f.ruleFile === '20-architecture.md');
            assert.ok(!migrated20, '20-architecture.md should NOT be migrated for ≤5 line tweaks');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not migrate legacy default code-style bootstrap content after template promotion', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '30-code-style.md'), LEGACY_DEFAULT_30, 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'no_significant_content');
            assert.ok(!result.migratedFiles.some((file) => file.ruleFile === '30-code-style.md'));

            const conventionsContent = fs.readFileSync(path.join(pmDir, 'conventions.md'), 'utf8');
            assert.ok(
                conventionsContent.includes('Fresh installs start with the seed conventions below;'),
                'template-seeded conventions content must remain intact'
            );
            assert.ok(
                !conventionsContent.includes('Bootstrap Policy When Repository Is Empty'),
                'legacy default bootstrap text must not overwrite project-memory conventions'
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates customized legacy code-style content that still retains old bootstrap markers', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '30-code-style.md'), LEGACY_CUSTOMIZED_30, 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'migrated');
            assert.ok(result.migratedFiles.some((file) => file.ruleFile === '30-code-style.md'));

            const conventionsContent = fs.readFileSync(path.join(pmDir, 'conventions.md'), 'utf8');
            assert.ok(
                conventionsContent.includes('Project TypeScript Conventions'),
                'user-authored legacy conventions must still migrate into project-memory'
            );
            assert.ok(
                conventionsContent.includes('Prefer explicit runtime validation for persisted JSON artifacts.'),
                'customized legacy style guidance must not be dropped'
            );
            assert.ok(
                !conventionsContent.includes('## Bootstrap Policy When Repository Is Empty'),
                'legacy bootstrap policy must not leak into migrated conventions'
            );
            assert.ok(
                !conventionsContent.includes('## Language-Specific Rules (Fill Only Relevant Sections)'),
                'legacy placeholder language sections must not leak into migrated conventions'
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates concise legacy code-style refinements even below the generic diff threshold', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '30-code-style.md'), LEGACY_MINIMAL_CUSTOMIZED_30, 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'migrated');
            const migrated30 = result.migratedFiles.find((file) => file.ruleFile === '30-code-style.md');
            assert.ok(migrated30, '30-code-style.md should migrate concise legacy refinements');
            assert.equal(migrated30.origin, 'legacy-docs');

            const conventionsContent = fs.readFileSync(path.join(pmDir, 'conventions.md'), 'utf8');
            assert.ok(conventionsContent.includes('## Team Conventions'));
            assert.ok(conventionsContent.includes('Prefer domain event names that read like past-tense business facts.'));
            assert.ok(!conventionsContent.includes('## Bootstrap Policy When Repository Is Empty'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('falls through from legacy bootstrap defaults to user-authored live code-style content', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '30-code-style.md'), LEGACY_DEFAULT_30, 'utf8');

            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '30-code-style.md'), LEGACY_CUSTOMIZED_30, 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'migrated');
            const migrated30 = result.migratedFiles.find((file) => file.ruleFile === '30-code-style.md');
            assert.ok(migrated30, '30-code-style.md should migrate from live-existing fallback');
            assert.equal(migrated30.origin, 'live-existing');

            const conventionsContent = fs.readFileSync(path.join(pmDir, 'conventions.md'), 'utf8');
            assert.ok(conventionsContent.includes('## Project TypeScript Conventions'));
            assert.ok(conventionsContent.includes('Keep handler modules thin: parse -> validate -> execute -> render.'));
            assert.ok(!conventionsContent.includes('## Bootstrap Policy When Repository Is Empty'));
            assert.ok(!conventionsContent.includes('## Language-Specific Rules (Fill Only Relevant Sections)'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not migrate legacy bootstrap files that only copy newer default style sections', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), pmDir);

            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '30-code-style.md'), LEGACY_BRIDGED_30, 'utf8');

            const result = migrateContextRulesToProjectMemory({
                bundleRoot,
                targetRoot: projectRoot,
                templateRoot: path.join(bundleRoot, 'template')
            });

            assert.equal(result.status, 'no_significant_content');
            assert.ok(!result.migratedFiles.some((file) => file.ruleFile === '30-code-style.md'));

            const conventionsContent = fs.readFileSync(path.join(pmDir, 'conventions.md'), 'utf8');
            assert.ok(
                !conventionsContent.includes('Bootstrap Policy When Repository Is Empty'),
                'bridged default sections must not cause obsolete bootstrap text to overwrite project-memory conventions'
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

// ──────────────────────────────────────────────────
// Integration: migration through runInit
// ──────────────────────────────────────────────────

describe('runInit with T-075 migration', () => {
    const repoRoot = findRepoRoot();

    it('includes migration in init report (T-075)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init to seed project-memory
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Place legacy user-authored rule
            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '10-project-context.md'), USER_AUTHORED_10, 'utf8');

            // Remove marker so migration can run
            const markerPath = path.join(bundleRoot, 'live', 'docs', 'project-memory', MIGRATION_MARKER);
            if (fs.existsSync(markerPath)) fs.rmSync(markerPath);

            // Second init (simulating reinit/update)
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.ok(result.projectMemoryMigration, 'migration result must be in init result');
            assert.equal(result.projectMemoryMigration.status, 'migrated');

            const report = fs.readFileSync(result.initReportPath, 'utf8');
            assert.ok(report.includes('Project-Memory Migration (T-075)'), 'init report must include migration section');
            assert.ok(report.includes('migrated'), 'init report must include migration status');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migration runs exactly once across multiple inits (T-075)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init — seeds project-memory
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Place legacy user-authored rule
            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '10-project-context.md'), USER_AUTHORED_10, 'utf8');

            // Remove marker from first init
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            const markerPath = path.join(pmDir, MIGRATION_MARKER);
            if (fs.existsSync(markerPath)) fs.rmSync(markerPath);

            // Second init — migration runs
            const result2 = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });
            assert.equal(result2.projectMemoryMigration.status, 'migrated');

            // Third init — migration must NOT run again
            const result3 = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });
            assert.equal(result3.projectMemoryMigration.status, 'already_migrated');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrated content appears in 15-project-memory.md summary (T-075)', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init — seeds project-memory
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Place legacy user-authored rule
            const legacyDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyDir, { recursive: true });
            fs.writeFileSync(path.join(legacyDir, '10-project-context.md'), USER_AUTHORED_10, 'utf8');

            // Remove marker from first init
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            const markerPath = path.join(pmDir, MIGRATION_MARKER);
            if (fs.existsSync(markerPath)) fs.rmSync(markerPath);

            // Second init — migration + summary generation
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const summary = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md'), 'utf8'
            );
            assert.ok(summary.includes('e-commerce platform'),
                'migrated content must appear in 15-project-memory.md summary');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

// ──────────────────────────────────────────────────
// Report builder
// ──────────────────────────────────────────────────

describe('buildMigrationReportLines', () => {
    it('reports already_migrated status', () => {
        const lines = buildMigrationReportLines({ status: 'already_migrated', migratedFiles: [] });
        assert.ok(lines.some(l => l.includes('marker file present')));
    });

    it('reports migrated status with file table', () => {
        const lines = buildMigrationReportLines({
            status: 'migrated',
            migratedFiles: [{
                ruleFile: '10-project-context.md',
                memoryFile: 'context.md',
                origin: 'legacy-docs',
                meaningfulLinesDetected: 12
            }]
        });
        assert.ok(lines.some(l => l.includes('**migrated**')));
        assert.ok(lines.some(l => l.includes('10-project-context.md')));
        assert.ok(lines.some(l => l.includes('context.md')));
    });

    it('reports no_significant_content status', () => {
        const lines = buildMigrationReportLines({ status: 'no_significant_content', migratedFiles: [] });
        assert.ok(lines.some(l => l.includes('no migration needed')));
    });
});
