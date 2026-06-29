import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

import {
    buildOptionalSkillSelectionArtifact,
    buildCurrentCycleOptionalSkillActivationIndex,
    buildMandatoryCurrentCycleOptionalSkillActivationIndex,
    computeOptionalSkillSelectionFingerprint,
    computeOptionalSkillTaskTextSha256,
    getOptionalSkillSelectionGateViolations,
    getOptionalSkillSelectionArtifactViolations,
    getOptionalSkillSelectionArtifactPath,
    isOptionalSkillSelectionPolicyConfigured,
    loadOptionalSkillSelectionHeadlinesCache,
    readOptionalSkillSelectionPolicyConfig,
    writeOptionalSkillSelectionArtifact,
    type OptionalSkillSelectionArtifactData
} from '../../../src/runtime/optional-skill-selection';
import { readSkillsHeadlines } from '../../../src/runtime/skill-headlines';

const NODE_BACKEND_SKILL_SOURCE = path.join(
    process.cwd(),
    'template',
    'skill-packs',
    'node-backend',
    'skills',
    'node-backend'
);

function makeBundleRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-optional-skills-'));
}

function seedOptionalSkillWorkspace(bundleRoot: string): void {
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
    fs.copyFileSync(
        path.join(process.cwd(), 'template', 'config', 'garda.config.json'),
        path.join(bundleRoot, 'live', 'config', 'garda.config.json')
    );
    fs.copyFileSync(
        path.join(process.cwd(), 'template', 'config', 'skill-packs.json'),
        path.join(bundleRoot, 'live', 'config', 'skill-packs.json')
    );
    fs.copyFileSync(
        path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
        path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
    );
    fs.cpSync(
        NODE_BACKEND_SKILL_SOURCE,
        path.join(bundleRoot, 'live', 'skills', 'node-backend'),
        { recursive: true }
    );
}

function writeSkillsHeadlinesFixture(bundleRoot: string, payload: Record<string, unknown>): void {
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'config', 'skills-headlines.json'),
        JSON.stringify(payload, null, 2),
        'utf8'
    );
}

function computeFileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('readOptionalSkillSelectionPolicyConfig falls back to optional defaults when config is absent', () => {
    const bundleRoot = makeBundleRoot();
    try {
        const config = readOptionalSkillSelectionPolicyConfig(bundleRoot);
        assert.equal(config.version, 1);
        assert.equal(config.mode, 'optional');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('readOptionalSkillSelectionPolicyConfig normalizes legacy policy aliases', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const policyPath = path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json');

        fs.writeFileSync(policyPath, JSON.stringify({ version: 1, mode: 'advisory' }, null, 2), 'utf8');
        assert.equal(readOptionalSkillSelectionPolicyConfig(bundleRoot).mode, 'optional');

        fs.writeFileSync(policyPath, JSON.stringify({ version: 1, mode: 'required' }, null, 2), 'utf8');
        assert.equal(readOptionalSkillSelectionPolicyConfig(bundleRoot).mode, 'mandatory');

        fs.writeFileSync(policyPath, JSON.stringify({ version: 1, mode: 'strict' }, null, 2), 'utf8');
        assert.equal(readOptionalSkillSelectionPolicyConfig(bundleRoot).mode, 'mandatory');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('readOptionalSkillSelectionPolicyConfig throws when garda.config.json still maps a missing managed policy file', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.rmSync(path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'), { force: true });

        assert.throws(
            () => readOptionalSkillSelectionPolicyConfig(bundleRoot),
            /Managed optional skill selection policy config is missing/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact selects matching installed optional skills from headlines metadata', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node backend TypeScript API service.',
            changedPaths: ['src/api/orders.ts']
        });

        assert.equal(artifact.payload.policy_mode, 'optional');
        assert.equal(artifact.payload.decision, 'selected_installed_skills');
        assert.deepEqual(artifact.payload.selected_installed_skills.map((entry) => entry.id), ['node-backend']);
        assert.match(
            artifact.payload.selected_installed_skills[0].allowed_skill_path,
            /live\/skills\/node-backend\/SKILL\.md$/
        );
        assert.match(artifact.payload.visible_summary_line, /Optional skills: node-backend/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('writeOptionalSkillSelectionArtifact persists artifact without emitting synthetic optional-skill telemetry', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        const artifactPath = getOptionalSkillSelectionArtifactPath(bundleRoot, 'T-149');
        assert.equal(artifact.artifactPath, artifactPath);
        assert.equal(fs.existsSync(artifactPath), true);

        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        assert.equal(fs.existsSync(eventsPath), false);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('writeOptionalSkillSelectionArtifact rebinds a prepared preview to the current preflight before validation', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const preview = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const preflightPath = path.join(bundleRoot, 'runtime', 'reviews', 'T-149-preflight.json');
        fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
        fs.writeFileSync(
            preflightPath,
            JSON.stringify({ task_id: 'T-149', changed_files: ['src/api/orders.ts'] }, null, 2),
            'utf8'
        );
        const preflightSha256 = computeFileSha256(preflightPath);

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts'],
            preflightPath,
            preflightSha256,
            preparedArtifact: preview
        });

        assert.equal(
            artifact.payload.preflight_path,
            preflightPath.replace(/\\/g, '/')
        );
        assert.equal(artifact.payload.preflight_sha256, preflightSha256);
        assert.deepEqual(
            getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
                requireMaterializedArtifact: true,
                expectedPreflightPath: preflightPath,
                expectedPreflightSha256: preflightSha256
            }),
            []
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact surfaces recommended_missing_packs distinctly from generic as_is fallback', () => {
    const bundleRoot = makeBundleRoot();
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.cpSync(
            path.join(process.cwd(), 'template', 'skill-packs'),
            path.join(bundleRoot, 'template', 'skill-packs'),
            { recursive: true }
        );
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'skill-packs.json'),
            path.join(bundleRoot, 'live', 'config', 'skill-packs.json')
        );
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
        );

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        assert.equal(artifact.payload.decision, 'recommended_missing_packs');
        assert.ok(artifact.payload.recommended_missing_packs.some((entry) => entry.id === 'node-backend'));
        assert.match(artifact.payload.visible_summary_line, /recommended_missing_packs/);
        assert.match(artifact.payload.visible_summary_line, /node-backend/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact suppresses missing frontend packs for backend control-plane context', () => {
    const bundleRoot = makeBundleRoot();
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
        );

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Stop recommending frontend-react for protected-control-plane runtime workflow gates.',
            changedPaths: ['src/gates/next-step/next-step.ts', 'src/runtime/optional-skill-selection/artifact-builder.ts'],
            loadedHeadlinesCache: {
                headlinesPath: path.join(bundleRoot, 'live', 'config', 'skills-headlines.json'),
                headlinesSha256: 'fixture-headlines-sha',
                materializationNeeded: false,
                skills: [],
                optional_packs: [{
                    id: 'frontend-react',
                    label: 'Frontend React',
                    description: 'Optional React and TypeScript frontend skills.',
                    installed: false,
                    implemented: true,
                    collides_with_baseline: false,
                    ready_skill_ids: ['frontend-react'],
                    placeholder_skill_ids: [],
                    recommended_for: ['React apps', 'UI tasks', 'frontend refactors'],
                    tags: ['frontend', 'react', 'typescript']
                }],
                payload: null
            }
        });

        assert.equal(artifact.payload.decision, 'as_is');
        assert.deepEqual(artifact.payload.recommended_missing_packs, []);
        assert.match(artifact.payload.visible_summary_line, /Optional skills: as_is/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact suppresses missing frontend packs for backend app paths', () => {
    const bundleRoot = makeBundleRoot();
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
        );

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Stop recommending frontend-react for backend runtime service work.',
            changedPaths: ['src/backend/app/server.ts'],
            loadedHeadlinesCache: {
                headlinesPath: path.join(bundleRoot, 'live', 'config', 'skills-headlines.json'),
                headlinesSha256: 'fixture-headlines-sha',
                materializationNeeded: false,
                skills: [],
                optional_packs: [{
                    id: 'frontend-react',
                    label: 'Frontend React',
                    description: 'Optional React and TypeScript frontend skills.',
                    installed: false,
                    implemented: true,
                    collides_with_baseline: false,
                    ready_skill_ids: ['frontend-react'],
                    placeholder_skill_ids: [],
                    recommended_for: ['React apps', 'UI tasks', 'frontend refactors'],
                    tags: ['frontend', 'react', 'typescript']
                }],
                payload: null
            }
        });

        assert.equal(artifact.payload.decision, 'as_is');
        assert.deepEqual(artifact.payload.recommended_missing_packs, []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact keeps missing frontend pack recommendation for explicit React UI context', () => {
    const bundleRoot = makeBundleRoot();
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
        );

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement a frontend React UI component for the dashboard.',
            changedPaths: ['src/frontend/react/DashboardCard.tsx'],
            loadedHeadlinesCache: {
                headlinesPath: path.join(bundleRoot, 'live', 'config', 'skills-headlines.json'),
                headlinesSha256: 'fixture-headlines-sha',
                materializationNeeded: false,
                skills: [],
                optional_packs: [{
                    id: 'frontend-react',
                    label: 'Frontend React',
                    description: 'Optional React and TypeScript frontend skills.',
                    installed: false,
                    implemented: true,
                    collides_with_baseline: false,
                    ready_skill_ids: ['frontend-react'],
                    placeholder_skill_ids: [],
                    recommended_for: ['React apps', 'UI tasks', 'frontend refactors'],
                    tags: ['frontend', 'react', 'typescript']
                }],
                payload: null
            }
        });

        assert.equal(artifact.payload.decision, 'recommended_missing_packs');
        assert.deepEqual(artifact.payload.recommended_missing_packs.map((entry) => entry.id), ['frontend-react']);
        assert.match(artifact.payload.visible_summary_line, /frontend-react/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact keeps explicit frontend text recommendation on shared runtime paths', () => {
    const bundleRoot = makeBundleRoot();
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
        );

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement a React UI component for the runtime dashboard.',
            changedPaths: ['src/runtime/dashboard-shell.ts'],
            loadedHeadlinesCache: {
                headlinesPath: path.join(bundleRoot, 'live', 'config', 'skills-headlines.json'),
                headlinesSha256: 'fixture-headlines-sha',
                materializationNeeded: false,
                skills: [],
                optional_packs: [{
                    id: 'frontend-react',
                    label: 'Frontend React',
                    description: 'Optional React and TypeScript frontend skills.',
                    installed: false,
                    implemented: true,
                    collides_with_baseline: false,
                    ready_skill_ids: ['frontend-react'],
                    placeholder_skill_ids: [],
                    recommended_for: ['React apps', 'UI tasks', 'frontend refactors'],
                    tags: ['frontend', 'react', 'typescript']
                }],
                payload: null
            }
        });

        assert.equal(artifact.payload.decision, 'recommended_missing_packs');
        assert.deepEqual(artifact.payload.recommended_missing_packs.map((entry) => entry.id), ['frontend-react']);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact keeps selected_installed_skills mutually exclusive from recommended_missing_packs', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);

        const selectedSkill = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        }).payload.selected_installed_skills[0];
        assert.ok(selectedSkill, 'Expected node-backend to be selected for the fixture task.');

        const loadedHeadlinesCache = {
            headlinesPath: path.join(bundleRoot, 'live', 'config', 'skills-headlines.json'),
            headlinesSha256: 'fixture-headlines-sha',
            materializationNeeded: false,
            skills: [
                {
                    id: 'node-backend',
                    directory: 'node-backend',
                    name: 'Node Backend',
                    summary: 'Node backend specialist for request validation and API work.',
                    pack: 'node-backend',
                    source: 'installed_optional' as const,
                    implemented: true,
                    review_binding: 'general_purpose' as const,
                    aliases: ['node', 'node-backend'],
                    task_signals: ['request validation', 'api endpoint', 'node-backend'],
                    changed_path_signals: ['orders.ts', 'src/api/'],
                    tags: ['api', 'backend', 'node']
                }
            ],
            optional_packs: [
                {
                    id: 'node-platform',
                    label: 'Node Platform',
                    description: 'Additional Node platform helpers.',
                    installed: false,
                    implemented: true,
                    collides_with_baseline: false,
                    ready_skill_ids: ['node-platform'],
                    placeholder_skill_ids: [],
                    recommended_for: ['request validation api endpoint'],
                    tags: ['api', 'node']
                }
            ],
            payload: null
        };

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts'],
            loadedHeadlinesCache
        });

        assert.equal(artifact.payload.decision, 'selected_installed_skills');
        assert.deepEqual(artifact.payload.selected_installed_skills.map((entry) => entry.id), [selectedSkill.id]);
        assert.deepEqual(artifact.payload.recommended_missing_packs, []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact produces explicit as_is fallback when no skill is relevant', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Tighten task-audit-summary closeout wiring for orchestrator control-plane.',
            changedPaths: ['src/gates/task-audit-summary.ts']
        });

        assert.equal(artifact.payload.selected_installed_skills.length, 0);
        assert.equal(artifact.payload.decision, 'as_is');
        assert.ok(artifact.payload.as_is_reason);
        assert.match(artifact.payload.visible_summary_line, /Optional skills: as_is/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations ignores a missing artifact when policy mode is advisory', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);

        assert.deepEqual(getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149'), []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations blocks DONE-path progression when strict evidence is missing', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'strict' }, null, 2),
            'utf8'
        );

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149');
        assert.ok(violations.some((entry) => entry.includes('Optional skill selection artifact is missing for current task cycle')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations rejects unauthorized optional skill loads under required mode', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );

        const changelogSkillRoot = path.join(bundleRoot, 'live', 'skills', 'changelog-writer');
        fs.mkdirSync(changelogSkillRoot, { recursive: true });
        fs.writeFileSync(
            path.join(changelogSkillRoot, 'skill.json'),
            JSON.stringify({
                id: 'changelog-writer',
                pack: 'release-tooling',
                name: 'Changelog Writer',
                summary: 'Writes changelog updates.',
                tags: ['docs', 'changelog'],
                aliases: ['release-notes'],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'suggest'
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(path.join(changelogSkillRoot, 'SKILL.md'), '# Changelog Writer\n', 'utf8');

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        fs.writeFileSync(eventsPath, JSON.stringify({
            timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 1000).toISOString(),
            event_type: 'SKILL_REFERENCE_LOADED',
            details: {
                skill_id: 'changelog-writer',
                reference_path: path.join(changelogSkillRoot, 'SKILL.md'),
                trigger_reason: 'manual'
            }
        }) + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });
        assert.ok(violations.some((entry) => entry.includes('is not authorized by the current optional skill selection artifact')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations blocks required mode when the selected optional skill disappears from current live inventory', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );

        writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        fs.rmSync(path.join(bundleRoot, 'live', 'skills', 'node-backend', 'SKILL.md'), { force: true });

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149');
        assert.ok(
            violations.some((entry) => (
                entry.includes("Selected skill 'node-backend' points to a missing skill reference path")
                && entry.includes('node-backend/SKILL.md')
            )),
            `Expected missing selected skill reference path violation, got: ${violations.join(' | ')}`
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations rejects unauthorized optional skill loads under advisory mode when a selection artifact exists', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);

        const changelogSkillRoot = path.join(bundleRoot, 'live', 'skills', 'changelog-writer');
        fs.mkdirSync(changelogSkillRoot, { recursive: true });
        fs.writeFileSync(
            path.join(changelogSkillRoot, 'skill.json'),
            JSON.stringify({
                id: 'changelog-writer',
                pack: 'release-tooling',
                name: 'Changelog Writer',
                summary: 'Writes changelog updates.',
                tags: ['docs', 'changelog'],
                aliases: ['release-notes'],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'suggest'
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(path.join(changelogSkillRoot, 'SKILL.md'), '# Changelog Writer\n', 'utf8');

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        fs.writeFileSync(eventsPath, JSON.stringify({
            timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 1000).toISOString(),
            event_type: 'SKILL_REFERENCE_LOADED',
            details: {
                skill_id: 'changelog-writer',
                reference_path: path.join(changelogSkillRoot, 'SKILL.md'),
                trigger_reason: 'manual'
            }
        }) + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });
        assert.ok(violations.some((entry) => entry.includes('is not authorized by the current optional skill selection artifact')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations ignores baseline skill loads under live/skills', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );
        const orchestrationRoot = path.join(bundleRoot, 'live', 'skills', 'orchestration');
        fs.mkdirSync(orchestrationRoot, { recursive: true });
        fs.writeFileSync(path.join(orchestrationRoot, 'SKILL.md'), '# Orchestration\n', 'utf8');

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        fs.writeFileSync(eventsPath, [
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 1000).toISOString(),
                event_type: 'TASK_MODE_ENTERED'
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 500).toISOString(),
                event_type: 'SKILL_SELECTED',
                details: {
                    skill_id: 'node-backend',
                    trigger_reason: 'optional_skill_selection'
                }
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 1000).toISOString(),
                event_type: 'SKILL_REFERENCE_LOADED',
                details: {
                    skill_id: 'orchestration',
                    reference_path: path.join(orchestrationRoot, 'SKILL.md'),
                    trigger_reason: 'bridge_route'
                }
            })
        ].join('\n') + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });
        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations still catches unauthorized optional skill loads that predate artifact materialization but follow task-mode entry', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );

        const changelogSkillRoot = path.join(bundleRoot, 'live', 'skills', 'changelog-writer');
        fs.mkdirSync(changelogSkillRoot, { recursive: true });
        fs.writeFileSync(
            path.join(changelogSkillRoot, 'skill.json'),
            JSON.stringify({
                id: 'changelog-writer',
                pack: 'release-tooling',
                name: 'Changelog Writer',
                summary: 'Writes changelog updates.',
                tags: ['docs', 'changelog'],
                aliases: ['release-notes'],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'suggest'
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(path.join(changelogSkillRoot, 'SKILL.md'), '# Changelog Writer\n', 'utf8');

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        fs.writeFileSync(eventsPath, [
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 2000).toISOString(),
                event_type: 'TASK_MODE_ENTERED'
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 1000).toISOString(),
                event_type: 'SKILL_REFERENCE_LOADED',
                details: {
                    skill_id: 'changelog-writer',
                    reference_path: path.join(changelogSkillRoot, 'SKILL.md'),
                    trigger_reason: 'manual'
                }
            })
        ].join('\n') + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });
        assert.ok(violations.some((entry) => entry.includes('is not authorized by the current optional skill selection artifact')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations allows reference loads inside the selected optional skill directory', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        const referencePath = path.join(bundleRoot, 'live', 'skills', 'node-backend', 'references', 'checklist.md');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        fs.writeFileSync(eventsPath, [
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 1000).toISOString(),
                event_type: 'TASK_MODE_ENTERED'
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 500).toISOString(),
                event_type: 'SKILL_SELECTED',
                details: {
                    skill_id: 'node-backend',
                    trigger_reason: 'optional_skill_selection'
                }
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 1000).toISOString(),
                event_type: 'SKILL_REFERENCE_LOADED',
                details: {
                    skill_id: 'node-backend',
                    reference_path: referencePath,
                    trigger_reason: 'optional_task_skill'
                }
            })
        ].join('\n') + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });
        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations rejects mandatory selected skills without current-cycle activation telemetry', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'mandatory' }, null, 2),
            'utf8'
        );

        writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149');

        assert.ok(violations.some((entry) => entry.includes('current-cycle activation evidence for selected optional skill(s): node-backend')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations rejects mandatory activation backfilled after implementation starts', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'mandatory' }, null, 2),
            'utf8'
        );

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const artifactTimestampMs = Date.parse(artifact.payload.timestamp_utc);
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        const eventLine = (
            offsetMs: number,
            eventType: string,
            taskSequence: number,
            details?: Record<string, unknown>
        ) => JSON.stringify({
            timestamp_utc: new Date(artifactTimestampMs + offsetMs).toISOString(),
            event_type: eventType,
            ...(details ? { details } : {}),
            integrity: {
                task_sequence: taskSequence
            }
        });
        fs.writeFileSync(eventsPath, [
            eventLine(-1000, 'TASK_MODE_ENTERED', 1),
            eventLine(100, 'PREFLIGHT_CLASSIFIED', 2),
            eventLine(500, 'IMPLEMENTATION_STARTED', 3),
            eventLine(1000, 'SKILL_SELECTED', 4, {
                skill_id: 'node-backend',
                trigger_reason: 'optional_skill_selection'
            })
        ].join('\n') + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });

        assert.ok(violations.some((entry) => entry.includes('activation was recorded too late for selected optional skill(s): node-backend')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations rejects mandatory activation reused across later preflight refresh', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'mandatory' }, null, 2),
            'utf8'
        );

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const artifactTimestampMs = Date.parse(artifact.payload.timestamp_utc);
        const selectionFingerprintSha256 = artifact.payload.selection_fingerprint_sha256
            || computeOptionalSkillSelectionFingerprint(artifact.payload);
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        const eventLine = (
            offsetMs: number,
            eventType: string,
            taskSequence: number,
            details?: Record<string, unknown>
        ) => JSON.stringify({
            timestamp_utc: new Date(artifactTimestampMs + offsetMs).toISOString(),
            event_type: eventType,
            ...(details ? { details } : {}),
            integrity: {
                task_sequence: taskSequence
            }
        });
        fs.writeFileSync(eventsPath, [
            eventLine(-1000, 'TASK_MODE_ENTERED', 1),
            eventLine(100, 'PREFLIGHT_CLASSIFIED', 2),
            eventLine(200, 'SKILL_SELECTED', 3, {
                skill_id: 'node-backend',
                trigger_reason: 'optional_skill_selection',
                optional_skill_selection_fingerprint_sha256: selectionFingerprintSha256
            }),
            eventLine(1000, 'PREFLIGHT_CLASSIFIED', 4)
        ].join('\n') + '\n', 'utf8');

        const activationIndex = buildCurrentCycleOptionalSkillActivationIndex(artifact.payload, {
            timelinePath: eventsPath,
            exists: true,
            invalidJson: false,
            eventTypes: new Set(['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'SKILL_SELECTED']),
            latestTaskModeEnteredTimestampUtc: new Date(artifactTimestampMs - 1000).toISOString(),
            latestTaskModeEnteredTaskSequence: 1,
            latestCycleBoundaryTimestampUtc: new Date(artifactTimestampMs + 1000).toISOString(),
            latestCycleBoundaryTaskSequence: 4,
            latestImplementationStartedTimestampUtc: null,
            latestImplementationStartedTaskSequence: null,
            optionalSkillActivations: [
                {
                    skillId: 'node-backend',
                    triggerReason: 'optional_skill_selection',
                    timestampUtc: new Date(artifactTimestampMs + 200).toISOString(),
                    eventSequence: 3,
                    selectionFingerprintSha256
                }
            ],
            optionalSkillReferenceLoads: []
        });
        assert.equal(activationIndex.has('node-backend'), true);
        const mandatoryActivationIndex = buildMandatoryCurrentCycleOptionalSkillActivationIndex(artifact.payload, {
            timelinePath: eventsPath,
            exists: true,
            invalidJson: false,
            eventTypes: new Set(['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'SKILL_SELECTED']),
            latestTaskModeEnteredTimestampUtc: new Date(artifactTimestampMs - 1000).toISOString(),
            latestTaskModeEnteredTaskSequence: 1,
            latestCycleBoundaryTimestampUtc: new Date(artifactTimestampMs + 1000).toISOString(),
            latestCycleBoundaryTaskSequence: 4,
            latestImplementationStartedTimestampUtc: null,
            latestImplementationStartedTaskSequence: null,
            optionalSkillActivations: [
                {
                    skillId: 'node-backend',
                    triggerReason: 'optional_skill_selection',
                    timestampUtc: new Date(artifactTimestampMs + 200).toISOString(),
                    eventSequence: 3,
                    selectionFingerprintSha256
                }
            ],
            optionalSkillReferenceLoads: []
        });
        assert.equal(mandatoryActivationIndex.has('node-backend'), false);

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });

        assert.ok(violations.some((entry) => entry.includes('current-cycle activation evidence for selected optional skill(s): node-backend')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations rejects selected optional skill loads that occur before activation telemetry', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        const referencePath = path.join(bundleRoot, 'live', 'skills', 'node-backend', 'references', 'checklist.md');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        fs.writeFileSync(eventsPath, [
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 1000).toISOString(),
                event_type: 'TASK_MODE_ENTERED'
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 1000).toISOString(),
                event_type: 'SKILL_REFERENCE_LOADED',
                details: {
                    skill_id: 'node-backend',
                    reference_path: referencePath,
                    trigger_reason: 'optional_task_skill'
                }
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 1500).toISOString(),
                event_type: 'SKILL_SELECTED',
                details: {
                    skill_id: 'node-backend',
                    trigger_reason: 'optional_skill_selection'
                }
            })
        ].join('\n') + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });
        assert.ok(violations.some((entry) => entry.includes('before optional skill activation completed')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations ignores prior-cycle optional skill loads after a new preflight restart in the same task-mode session', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );

        const changelogSkillRoot = path.join(bundleRoot, 'live', 'skills', 'changelog-writer');
        fs.mkdirSync(changelogSkillRoot, { recursive: true });
        fs.writeFileSync(
            path.join(changelogSkillRoot, 'skill.json'),
            JSON.stringify({
                id: 'changelog-writer',
                pack: 'release-tooling',
                name: 'Changelog Writer',
                summary: 'Writes changelog updates.',
                tags: ['docs', 'changelog'],
                aliases: ['release-notes'],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'suggest'
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(path.join(changelogSkillRoot, 'SKILL.md'), '# Changelog Writer\n', 'utf8');

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        fs.writeFileSync(eventsPath, [
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 4000).toISOString(),
                event_type: 'TASK_MODE_ENTERED'
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 3000).toISOString(),
                event_type: 'SKILL_REFERENCE_LOADED',
                details: {
                    skill_id: 'changelog-writer',
                    reference_path: path.join(changelogSkillRoot, 'SKILL.md'),
                    trigger_reason: 'manual'
                }
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 1000).toISOString(),
                event_type: 'PREFLIGHT_STARTED'
            }),
            JSON.stringify({
                timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) - 500).toISOString(),
                event_type: 'SKILL_SELECTED',
                details: {
                    skill_id: 'node-backend',
                    trigger_reason: 'optional_skill_selection'
                }
            })
        ].join('\n') + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });
        assert.deepEqual(violations, []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildCurrentCycleOptionalSkillActivationIndex keeps same-selection activation across preflight restart', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const fingerprint = artifact.payload.selection_fingerprint_sha256
            || computeOptionalSkillSelectionFingerprint(artifact.payload);

        const activationIndex = buildCurrentCycleOptionalSkillActivationIndex(artifact.payload, {
            timelinePath: path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl'),
            exists: true,
            invalidJson: false,
            eventTypes: new Set(['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'SKILL_SELECTED']),
            latestTaskModeEnteredTimestampUtc: '2026-01-01T00:00:00.000Z',
            latestCycleBoundaryTimestampUtc: '2026-01-01T00:00:10.000Z',
            optionalSkillActivations: [
                {
                    skillId: 'node-backend',
                    triggerReason: 'optional_skill_selection',
                    timestampUtc: '2026-01-01T00:00:05.000Z',
                    selectionFingerprintSha256: fingerprint
                }
            ],
            optionalSkillReferenceLoads: []
        });

        assert.equal(activationIndex.has('node-backend'), true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildCurrentCycleOptionalSkillActivationIndex computes fallback fingerprint for legacy artifacts', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const fingerprint = computeOptionalSkillSelectionFingerprint(artifact.payload);
        delete artifact.payload.selection_fingerprint_sha256;

        const activationIndex = buildCurrentCycleOptionalSkillActivationIndex(artifact.payload, {
            timelinePath: path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl'),
            exists: true,
            invalidJson: false,
            eventTypes: new Set(['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'SKILL_SELECTED']),
            latestTaskModeEnteredTimestampUtc: '2026-01-01T00:00:00.000Z',
            latestCycleBoundaryTimestampUtc: '2026-01-01T00:00:10.000Z',
            optionalSkillActivations: [
                {
                    skillId: 'node-backend',
                    triggerReason: 'optional_skill_selection',
                    timestampUtc: '2026-01-01T00:00:05.000Z',
                    selectionFingerprintSha256: fingerprint
                }
            ],
            optionalSkillReferenceLoads: []
        });

        assert.equal(activationIndex.has('node-backend'), true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('computeOptionalSkillSelectionFingerprint ignores volatile selection inputs', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const refreshedPayload = JSON.parse(JSON.stringify(artifact.payload)) as typeof artifact.payload;
        refreshedPayload.task_text_sha256 = computeOptionalSkillTaskTextSha256('Implement validation for a different API endpoint.');
        refreshedPayload.changed_paths = ['src/api/refreshed-orders.ts'];
        refreshedPayload.headlines_sha256 = 'refreshed-headlines';
        refreshedPayload.selected_installed_skills = refreshedPayload.selected_installed_skills.map((entry) => ({
            ...entry,
            reason_codes: ['changed_path_signals' as const],
            matches: {
                task_signals: ['different task signal'],
                changed_path_signals: ['src/api/refreshed-orders.ts']
            }
        }));

        assert.equal(
            computeOptionalSkillSelectionFingerprint(refreshedPayload),
            computeOptionalSkillSelectionFingerprint(artifact.payload)
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildCurrentCycleOptionalSkillActivationIndex rejects prior selection activation after preflight restart', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        const activationIndex = buildCurrentCycleOptionalSkillActivationIndex(artifact.payload, {
            timelinePath: path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl'),
            exists: true,
            invalidJson: false,
            eventTypes: new Set(['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'SKILL_SELECTED']),
            latestTaskModeEnteredTimestampUtc: '2026-01-01T00:00:00.000Z',
            latestCycleBoundaryTimestampUtc: '2026-01-01T00:00:10.000Z',
            optionalSkillActivations: [
                {
                    skillId: 'node-backend',
                    triggerReason: 'optional_skill_selection',
                    timestampUtc: '2026-01-01T00:00:05.000Z',
                    selectionFingerprintSha256: 'different-selection'
                }
            ],
            optionalSkillReferenceLoads: []
        });

        assert.equal(activationIndex.has('node-backend'), false);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionGateViolations rejects optional skill loads when policy mode is off', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'off' }, null, 2),
            'utf8'
        );

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', 'T-149.jsonl');
        const nodeBackendSkillPath = path.join(bundleRoot, 'live', 'skills', 'node-backend', 'SKILL.md');
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        fs.writeFileSync(eventsPath, JSON.stringify({
            timestamp_utc: new Date(Date.parse(artifact.payload.timestamp_utc) + 1000).toISOString(),
            event_type: 'SKILL_REFERENCE_LOADED',
            details: {
                skill_id: 'node-backend',
                reference_path: nodeBackendSkillPath,
                trigger_reason: 'manual'
            }
        }) + '\n', 'utf8');

        const violations = getOptionalSkillSelectionGateViolations(bundleRoot, 'T-149', {
            taskEventsPath: eventsPath
        });
        assert.ok(violations.some((entry) => entry.includes("policy mode is 'off'")));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('isOptionalSkillSelectionPolicyConfigured activates from garda.config.json mapping not stray file alone', () => {
    const bundleRoot = makeBundleRoot();
    try {
        assert.equal(isOptionalSkillSelectionPolicyConfigured(bundleRoot), false);
        seedOptionalSkillWorkspace(bundleRoot);
        assert.equal(isOptionalSkillSelectionPolicyConfigured(bundleRoot), true);
        // Removing only the policy file should NOT deactivate since garda.config.json still maps it.
        fs.rmSync(path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'), { force: true });
        assert.equal(isOptionalSkillSelectionPolicyConfigured(bundleRoot), true);
        // Removing garda.config.json DOES deactivate the policy.
        fs.rmSync(path.join(bundleRoot, 'live', 'config', 'garda.config.json'), { force: true });
        assert.equal(isOptionalSkillSelectionPolicyConfigured(bundleRoot), false);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('writeOptionalSkillSelectionArtifact binds headlines metadata to the current on-disk headlines surface', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const headlinesPath = path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
        fs.writeFileSync(headlinesPath, JSON.stringify({ stale: true }, null, 2), 'utf8');

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const currentHeadlinesText = `${fs.readFileSync(headlinesPath, 'utf8').trim()}\n`;
        const currentHeadlinesSha256 = createHash('sha256').update(currentHeadlinesText, 'utf8').digest('hex');

        assert.equal(
            artifact.payload.headlines_path,
            path.relative(path.dirname(bundleRoot), headlinesPath).replace(/\\/g, '/')
        );
        assert.equal(artifact.payload.headlines_sha256, currentHeadlinesSha256);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('writeOptionalSkillSelectionArtifact does not rewrite an already-current headlines surface when a prepared preview reused the persisted payload', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const headlinesPath = path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
        const frozenDate = new Date('2020-01-01T00:00:00.000Z');
        fs.utimesSync(headlinesPath, frozenDate, frozenDate);

        const preview = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts'],
            preparedArtifact: preview,
            loadedHeadlinesCache: preview.loadedHeadlinesCache || null
        });

        assert.equal(fs.statSync(headlinesPath).mtimeMs, frozenDate.getTime());
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact keeps off mode internally consistent', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'off' }, null, 2),
            'utf8'
        );

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        assert.equal(artifact.payload.policy_mode, 'off');
        assert.equal(artifact.payload.decision, 'as_is');
        assert.equal(artifact.payload.as_is_reason, 'policy_off');
        assert.equal(artifact.payload.selected_installed_skills.length, 0);
        assert.equal(artifact.payload.recommended_missing_packs.length, 0);
        assert.match(artifact.payload.visible_summary_line, /Optional skills: as_is \(reason: policy_off\)/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact keeps allowed_skill_path aligned with live skill directory names', () => {
    const bundleRoot = makeBundleRoot();
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.cpSync(
            path.join(process.cwd(), 'template', 'skill-packs'),
            path.join(bundleRoot, 'template', 'skill-packs'),
            { recursive: true }
        );
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'skill-packs.json'),
            path.join(bundleRoot, 'live', 'config', 'skill-packs.json')
        );
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
        );

        const skillRoot = path.join(bundleRoot, 'live', 'skills', 'node-server-specialist');
        fs.mkdirSync(skillRoot, { recursive: true });
        fs.writeFileSync(path.join(skillRoot, 'skill.json'), JSON.stringify({
            id: 'node-backend-specialist',
            name: 'Node Backend Specialist',
            summary: 'Node backend API implementation helper.',
            tags: ['node', 'backend', 'api'],
            aliases: ['node-backend'],
            task_signals: ['request validation', 'endpoint'],
            changed_path_signals: ['src/api/'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend Specialist\n', 'utf8');

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        assert.equal(artifact.payload.selected_installed_skills[0].id, 'node-backend-specialist');
        assert.match(
            artifact.payload.selected_installed_skills[0].allowed_skill_path,
            /live\/skills\/node-server-specialist\/SKILL\.md$/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact does not cross-select sibling skills from the same pack', () => {
    const bundleRoot = makeBundleRoot();
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills', 'angular-app'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills', 'nextjs-app'), { recursive: true });
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'skill-packs.json'),
            path.join(bundleRoot, 'live', 'config', 'skill-packs.json')
        );
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
        );
        fs.writeFileSync(path.join(bundleRoot, 'live', 'skills', 'angular-app', 'SKILL.md'), '# Angular App\n', 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'live', 'skills', 'nextjs-app', 'SKILL.md'), '# Next.js App\n', 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'live', 'skills', 'angular-app', 'skill.json'), JSON.stringify({
            id: 'angular-app',
            pack: 'frontend-web',
            name: 'Angular App',
            summary: 'Angular frontend application specialist.',
            tags: ['angular', 'frontend'],
            aliases: ['angular'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'live', 'skills', 'nextjs-app', 'skill.json'), JSON.stringify({
            id: 'nextjs-app',
            pack: 'frontend-web',
            name: 'Next.js App',
            summary: 'Next.js frontend application specialist.',
            tags: ['nextjs', 'frontend'],
            aliases: ['nextjs'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2), 'utf8');

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement an angular-app route guard.',
            changedPaths: ['src/angular/app.routes.ts']
        });

        assert.equal(artifact.payload.decision, 'selected_installed_skills');
        assert.deepEqual(artifact.payload.selected_installed_skills.map((entry) => entry.id), ['angular-app']);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact does not select a skill whose SKILL.md was deleted from live/skills', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        // First confirm the skill is selected normally.
        const artifact1 = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        assert.equal(artifact1.payload.decision, 'selected_installed_skills');
        assert.ok(artifact1.payload.selected_installed_skills.some((entry) => entry.id === 'node-backend'));

        // Delete the SKILL.md but leave skill.json (simulates partial deletion).
        fs.rmSync(path.join(bundleRoot, 'live', 'skills', 'node-backend', 'SKILL.md'), { force: true });

        // Build again with the same signals – skill should NOT be selected.
        const artifact2 = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        assert.ok(!artifact2.payload.selected_installed_skills.some((entry) => entry.id === 'node-backend'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact requires a strong primary match before selecting a docs/process skill', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);

        const skillRoot = path.join(bundleRoot, 'live', 'skills', 'changelog-writer');
        fs.mkdirSync(skillRoot, { recursive: true });
        fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Changelog Writer\n', 'utf8');
        fs.writeFileSync(path.join(skillRoot, 'skill.json'), JSON.stringify({
            id: 'changelog-writer',
            pack: 'release-tooling',
            name: 'Changelog Writer',
            summary: 'Write changelog and release notes docs from relevant task details.',
            tags: ['docs', 'changelog', 'release'],
            aliases: ['release-notes'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2), 'utf8');

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Add optional skill selection policy and update changelog docs for the workflow.',
            changedPaths: ['src/runtime/optional-skill-selection.ts', 'docs/configuration.md', 'CHANGELOG.md']
        });

        assert.equal(artifact.payload.decision, 'as_is');
        assert.deepEqual(artifact.payload.selected_installed_skills, []);
        assert.ok(artifact.payload.as_is_reason);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects forged selected skills that are not in the current installed inventory', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        artifact.payload.selected_installed_skills[0] = {
            ...artifact.payload.selected_installed_skills[0],
            id: 'forged-skill',
            pack: 'forged-pack'
        };

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact);
        assert.ok(violations.some((entry) => entry.includes('current installed optional skill inventory')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects stale selection fingerprint fields', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        artifact.payload.selection_fingerprint_sha256 = 'stale-selection-fingerprint';

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact);

        assert.ok(violations.some((entry) => entry.includes('selection_fingerprint_sha256')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects artifacts bound to a stale preflight hash', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const preflightPath = path.join(bundleRoot, 'runtime', 'reviews', 'T-149-preflight.json');
        fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: 'T-149', changed_files: ['src/api/orders.ts'] }, null, 2), 'utf8');

        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts'],
            preflightPath,
            preflightSha256: computeFileSha256(preflightPath)
        });

        fs.writeFileSync(preflightPath, JSON.stringify({ task_id: 'T-149', changed_files: ['src/api/payments.ts'] }, null, 2), 'utf8');

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
            requireMaterializedArtifact: true,
            expectedPreflightPath: preflightPath,
            expectedPreflightSha256: computeFileSha256(preflightPath)
        });

        assert.ok(violations.some((entry) => entry.includes('current preflight artifact hash')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects artifacts bound to a stale task summary hash', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
            expectedTaskTextSha256: computeOptionalSkillTaskTextSha256('Refresh landing-page copy for the marketing site.')
        });

        assert.ok(violations.some((entry) => entry.includes('current task summary hash')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects artifacts when the current task row disappears and no task summary hash is available', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
            expectedTaskTextSha256: null
        });

        assert.ok(violations.some((entry) => entry.includes('current task summary hash')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects artifacts whose policy_mode no longer matches the current config', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = writeOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'strict' }, null, 2),
            'utf8'
        );

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
            requireMaterializedArtifact: true,
            expectedPolicyMode: 'strict'
        });

        assert.ok(violations.some((entry) => entry.includes("current policy mode 'strict'")));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects recommended_missing_packs that drift against current pack inventory', () => {
    const bundleRoot = makeBundleRoot();
    try {
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.cpSync(
            path.join(process.cwd(), 'template', 'skill-packs'),
            path.join(bundleRoot, 'template', 'skill-packs'),
            { recursive: true }
        );
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'skill-packs.json'),
            path.join(bundleRoot, 'live', 'config', 'skill-packs.json')
        );
        fs.copyFileSync(
            path.join(process.cwd(), 'template', 'config', 'optional-skill-selection-policy.json'),
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json')
        );

        writeSkillsHeadlinesFixture(bundleRoot, {
            version: 2,
            installed_pack_ids: [],
            baseline_skill_ids: [],
            installed_optional_skill_ids: [],
            custom_skill_ids: [],
            skills: [],
            optional_packs: [
                {
                    id: 'node-backend',
                    label: 'Node Backend',
                    description: 'Node backend specialist pack.',
                    installed: false,
                    implemented: true,
                    collides_with_baseline: false,
                    ready_skill_ids: ['node-backend'],
                    placeholder_skill_ids: [],
                    recommended_for: ['node backend'],
                    tags: ['node', 'backend']
                }
            ]
        });
        const artifact = {
            artifactPath: path.join(bundleRoot, 'runtime', 'reviews', 'T-149-optional-skill-selection.json'),
            payload: {
                schema_version: 1 as const,
                event_source: 'optional-skill-selection',
                task_id: 'T-149',
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'recommended_missing_packs',
                selected_installed_skills: [],
                recommended_missing_packs: [
                    {
                        id: 'node-backend',
                        label: 'Node Backend',
                        ready_skill_ids: ['node-backend'],
                        reason_codes: ['task_signals'],
                        matches: { task_signals: ['node-backend'], changed_path_signals: [] }
                    }
                ],
                as_is_reason: 'no_relevant_installed_skill',
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint.'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: null,
                preflight_sha256: null,
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: computeFileSha256(path.join(bundleRoot, 'live', 'config', 'skills-headlines.json')),
                visible_summary_line: 'Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text)'
            }
        } as const;

        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'skill-packs.json'),
            JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
            'utf8'
        );

        const violations = getOptionalSkillSelectionArtifactViolations(
            bundleRoot,
            artifact as unknown as OptionalSkillSelectionArtifactData
        );
        assert.ok(violations.some((entry) => entry.includes('already installed')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('buildOptionalSkillSelectionArtifact rebuilds from current live skills when persisted headlines are stale', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        writeSkillsHeadlinesFixture(bundleRoot, {
            version: 2,
            installed_pack_ids: [],
            baseline_skill_ids: [],
            installed_optional_skill_ids: [],
            custom_skill_ids: [],
            skills: [],
            optional_packs: []
        });

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });

        assert.equal(artifact.payload.decision, 'selected_installed_skills');
        assert.deepEqual(artifact.payload.selected_installed_skills.map((entry) => entry.id), ['node-backend']);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('loadOptionalSkillSelectionHeadlinesCache does not reuse a valid-but-stale persisted headlines surface in preferPersistedSurface mode', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        writeSkillsHeadlinesFixture(bundleRoot, {
            version: 2,
            source_state_sha256: 'stale-source-state',
            source_state_hint_sha256: 'stale-source-state-hint',
            installed_pack_ids: [],
            baseline_skill_ids: [],
            installed_optional_skill_ids: [],
            custom_skill_ids: [],
            skills: [],
            optional_packs: []
        });

        const loadedHeadlinesCache = loadOptionalSkillSelectionHeadlinesCache(bundleRoot, 'advisory', {
            preferPersistedSurface: true
        });
        assert.ok(loadedHeadlinesCache, 'Expected headlines cache to be built.');
        assert.ok(
            loadedHeadlinesCache.skills.some((entry) => entry.id === 'node-backend'),
            'Expected current live node-backend skill to be present after stale headlines revalidation.'
        );

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts'],
            loadedHeadlinesCache
        });

        assert.equal(artifact.payload.decision, 'selected_installed_skills');
        assert.deepEqual(artifact.payload.selected_installed_skills.map((entry) => entry.id), ['node-backend']);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('loadOptionalSkillSelectionHeadlinesCache reuses the current persisted surface in preferPersistedSurface mode without rebuilding it', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const currentHeadlines = readSkillsHeadlines(bundleRoot);
        writeSkillsHeadlinesFixture(bundleRoot, {
            ...currentHeadlines.payload,
            debug_marker: 'persisted-surface'
        });

        const loadedHeadlinesCache = loadOptionalSkillSelectionHeadlinesCache(bundleRoot, 'advisory', {
            preferPersistedSurface: true
        });

        assert.ok(loadedHeadlinesCache, 'Expected headlines cache to be loaded.');
        assert.equal(loadedHeadlinesCache.materializationNeeded, false);
        const persistedPayload = loadedHeadlinesCache.payload as unknown as Record<string, unknown>;
        assert.equal(
            persistedPayload.debug_marker,
            'persisted-surface'
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects non-materialized required artifacts and missing strict fallback reason', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const policyPath = path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json');
        fs.writeFileSync(policyPath, JSON.stringify({ version: 1, mode: 'strict' }, null, 2), 'utf8');

        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Tighten task-audit-summary closeout wiring for orchestrator control-plane.',
            changedPaths: ['src/gates/task-audit-summary.ts']
        });
        artifact.payload.as_is_reason = null;

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
            requireMaterializedArtifact: true
        });

        assert.ok(violations.some((entry) => entry.includes('missing for current task cycle')));
        assert.ok(violations.some((entry) => entry.includes("requires an explicit as_is_reason")));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects forged off-mode artifacts with residual selections', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        artifact.payload.policy_mode = 'off';
        artifact.payload.decision = 'selected_installed_skills';
        artifact.payload.selected_installed_skills = [{
            ...artifact.payload.selected_installed_skills[0]
        }];
        artifact.payload.recommended_missing_packs = [{
            id: 'node-backend',
            label: 'Node Backend',
            ready_skill_ids: ['node-backend'],
            reason_codes: ['task_signals'],
            matches: { task_signals: ['node-backend'], changed_path_signals: [] }
        }];
        artifact.payload.as_is_reason = 'policy_off';

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact);
        assert.ok(violations.some((entry) => entry.includes("Policy mode 'off' must not include selected_installed_skills")));
        assert.ok(violations.some((entry) => entry.includes("Policy mode 'off' must not include recommended_missing_packs")));
        assert.ok(violations.some((entry) => entry.includes("Policy mode 'off' must emit decision 'as_is'")));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects unexpected schema_version and event_source metadata', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        artifact.payload.schema_version = 99 as 1;
        artifact.payload.event_source = 'foreign-artifact' as 'optional-skill-selection';

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact);
        assert.ok(violations.some((entry) => entry.includes("schema_version '99' is invalid")));
        assert.ok(violations.some((entry) => entry.includes("event_source must equal 'optional-skill-selection'")));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('getOptionalSkillSelectionArtifactViolations rejects duplicate and oversized selected skill lists', () => {
    const bundleRoot = makeBundleRoot();
    try {
        seedOptionalSkillWorkspace(bundleRoot);
        const artifact = buildOptionalSkillSelectionArtifact(bundleRoot, 'T-149', {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts']
        });
        const selectedSkill = artifact.payload.selected_installed_skills[0];
        artifact.payload.selected_installed_skills = [selectedSkill, selectedSkill, selectedSkill];

        const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact);
        assert.ok(violations.some((entry) => entry.includes('maximum selected_installed_skills count')));
        assert.ok(violations.some((entry) => entry.includes('duplicate selected_installed_skills')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});
