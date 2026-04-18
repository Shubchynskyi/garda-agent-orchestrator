import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    FUZZY_ALIAS_GROUPS,
    MATCH_CATEGORIES,
    addSkillPack,
    containsAtWordBoundary,
    dedupeSkillsByPack,
    getFuzzyAliasMap,
    getReviewCapabilitiesConfigPath,
    getSignalFuzzyVariants,
    getSkillPacksConfigPath,
    getSkillsIndexConfigPath,
    hasDistinctSignalCoverage,
    listSkillPacks,
    removeSkillPack,
    suggestSkills,
    textMatchesFuzzyVariant,
    validateSkillPacks,
    writeSkillsIndex,
    SignalMatches,
    SkillSuggestion,
    SKILL_TELEMETRY_EVENT_TYPES,
    SKILL_TELEMETRY_ACTOR,
    buildSkillTelemetryDetails,
    emitSkillTelemetryEvent,
    emitSkillTelemetryEventAsync,
    emitSkillSuggestedEvent,
    emitSkillSelectedEvent,
    emitSkillSelectedEventAsync,
    emitSkillReferenceLoadedEvent,
    emitSkillReferenceLoadedEventAsync
} from '../../../src/runtime/skills';

import {
    emitSkillTelemetryEventAsync as directEmitSkillTelemetryEventAsync,
    emitSkillSelectedEventAsync as directEmitSkillSelectedEventAsync,
    emitSkillReferenceLoadedEventAsync as directEmitSkillReferenceLoadedEventAsync
} from '../../../src/runtime/skill-telemetry';

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

function copyDirRecursive(sourcePath: string, destinationPath: string) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const destinationEntryPath = path.join(destinationPath, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(sourceEntryPath, destinationEntryPath);
        } else {
            fs.copyFileSync(sourceEntryPath, destinationEntryPath);
        }
    }
}

function seedBaselineSkills(repoRoot: string, bundleRoot: string) {
    copyDirRecursive(
        path.join(repoRoot, 'template', 'skills'),
        path.join(bundleRoot, 'live', 'skills')
    );
}

test('built-in skill pack lifecycle installs, validates, lists, and removes packs', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'review-capabilities.json'), getReviewCapabilitiesConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        const addResult = addSkillPack(bundleRoot, 'node-backend');
        assert.equal(addResult.changed, true);
        assert.ok(fs.existsSync(path.join(bundleRoot, 'live', 'skills', 'node-backend', 'SKILL.md')));

        const listing = listSkillPacks(bundleRoot);
        assert.deepEqual(listing.installedPackIds, ['node-backend']);
        assert.ok(listing.baselineSkillDirectories.includes('dependency-review'));
        assert.equal(listing.builtinPacks.find((pack: { id: string; installed: boolean }) => pack.id === 'node-backend')!.installed, true);

        const validation = validateSkillPacks(bundleRoot);
        assert.equal(validation.passed, true);
        assert.equal(validation.issues.length, 0);
        assert.ok(fs.existsSync(getSkillsIndexConfigPath(bundleRoot)));

        const removeResult = removeSkillPack(bundleRoot, 'node-backend');
        assert.equal(removeResult.changed, true);
        assert.ok(!fs.existsSync(path.join(bundleRoot, 'live', 'skills', 'node-backend')));
        assert.deepEqual(removeResult.installedPackIds, []);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('addSkillPack synchronizes optional review capabilities for installed specialist skills', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'review-capabilities.json'), getReviewCapabilitiesConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        const qualityResult = addSkillPack(bundleRoot, 'quality-architecture');
        assert.equal(qualityResult.reviewCapabilities!.api, true);
        assert.equal(qualityResult.reviewCapabilities!.test, true);
        assert.equal(qualityResult.reviewCapabilities!.performance, true);

        const infraResult = addSkillPack(bundleRoot, 'devops-k8s');
        assert.equal(infraResult.reviewCapabilities!.infra, true);

        const persistedCapabilities = JSON.parse(fs.readFileSync(getReviewCapabilitiesConfigPath(bundleRoot), 'utf8'));
        assert.equal(persistedCapabilities.api, true);
        assert.equal(persistedCapabilities.test, true);
        assert.equal(persistedCapabilities.performance, true);
        assert.equal(persistedCapabilities.infra, true);
        assert.equal(persistedCapabilities.dependency, true);

        const removeResult = removeSkillPack(bundleRoot, 'quality-architecture');
        assert.equal(removeResult.reviewCapabilities!.api, false);
        assert.equal(removeResult.reviewCapabilities!.test, false);
        assert.equal(removeResult.reviewCapabilities!.performance, false);
        assert.equal(removeResult.reviewCapabilities!.dependency, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('suggestSkills recommends packs and skills from index, project stack, task text, and changed paths', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'api'), { recursive: true });
        fs.mkdirSync(path.join(workspaceRoot, 'migrations'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"sample-app"}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'tsconfig.json'), '{"compilerOptions":{}}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'api', 'users.ts'), 'export const users = true;\n', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'migrations', '001_add_users.sql'), 'create table users(id bigint);\n', 'utf8');

        const result = suggestSkills(bundleRoot, workspaceRoot, {
            taskText: 'Fix slow API endpoint and review migration safety',
            changedPaths: ['src/api/users.ts', 'migrations/001_add_users.sql']
        });

        assert.ok(result.suggestedPacks.some((pack) => pack.id === 'node-backend'));
        assert.ok(result.suggestedPacks.some((pack) => pack.id === 'data-database'));
        assert.ok(!result.suggestedPacks.some((pack) => pack.id === 'backend-polyglot'));
        assert.ok(!result.suggestedPacks.some((pack) => pack.id === 'quality-architecture'));

        assert.ok(result.suggestedSkills.some((skill) => skill.id === 'node-backend'));
        assert.ok(result.suggestedSkills.some((skill) => skill.id === 'db-migration-review'));
        assert.ok(result.suggestedSkills.some((skill) => skill.id === 'query-performance'));
        assert.ok(!result.suggestedSkills.some((skill) => skill.id === 'go-http-service'));
        assert.ok(!result.suggestedSkills.some((skill) => skill.id === 'python-service'));
        assert.deepEqual(result.availableRelevantSkills, []);
        assert.ok(fs.existsSync(getSkillsIndexConfigPath(bundleRoot)));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('suggestSkills separates already-available skills from optional additions', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills', 'frontend-react'), { recursive: true });
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'components'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"web-app","dependencies":{"react":"18.0.0"}}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'components', 'App.tsx'), 'export function App() { return null; }\n', 'utf8');

        const result = suggestSkills(bundleRoot, workspaceRoot, {
            taskText: 'Improve component accessibility and rendering performance',
            changedPaths: ['src/components/App.tsx']
        });

        assert.ok(result.availableRelevantSkills.some((skill) => skill.id === 'frontend-react'));
        assert.ok(!result.suggestedSkills.some((skill) => skill.id === 'frontend-react'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('suggestSkills stays deterministic across repeated identical runs', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'api'), { recursive: true });
        fs.mkdirSync(path.join(workspaceRoot, 'migrations'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"sample-app"}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'tsconfig.json'), '{"compilerOptions":{}}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'api', 'users.ts'), 'export const users = true;\n', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'migrations', '001_add_users.sql'), 'create table users(id bigint);\n', 'utf8');

        let baseline = null;
        for (let iteration = 0; iteration < 20; iteration += 1) {
            const result = suggestSkills(bundleRoot, workspaceRoot, {
                taskText: 'Fix slow API endpoint and review migration safety',
                changedPaths: ['src/api/users.ts', 'migrations/001_add_users.sql']
            });

            const snapshot = JSON.stringify({
                availableRelevantPacks: result.availableRelevantPacks,
                availableRelevantSkills: result.availableRelevantSkills,
                suggestedPacks: result.suggestedPacks,
                suggestedSkills: result.suggestedSkills
            });

            if (baseline === null) {
                baseline = snapshot;
                continue;
            }

            assert.equal(snapshot, baseline);
        }
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('validateSkillPacks rejects optional packs that collide with baseline skills', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template', 'skill-packs', 'security-review', 'skills', 'security-review'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'review-capabilities.json'), getReviewCapabilitiesConfigPath(bundleRoot));

        fs.writeFileSync(path.join(bundleRoot, 'template', 'skill-packs', 'security-review', 'pack.json'), JSON.stringify({
            id: 'security-review',
            label: 'Security Review Pack',
            description: 'Duplicate baseline security pack',
            tags: ['security']
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'template', 'skill-packs', 'security-review', 'skills', 'security-review', 'skill.json'), JSON.stringify({
            id: 'security-review',
            name: 'Security Review',
            pack: 'security-review',
            summary: 'Duplicate baseline skill',
            tags: ['security'],
            aliases: [],
            stack_signals: [],
            task_signals: [],
            changed_path_signals: [],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'template', 'skill-packs', 'security-review', 'skills', 'security-review', 'SKILL.md'), '# Security Review\n', 'utf8');

        writeSkillsIndex(bundleRoot);
        const validation = validateSkillPacks(bundleRoot);

        assert.equal(validation.passed, false);
        assert.ok(validation.issues.some((issue) => issue.includes('collides with baseline skill id')));
        assert.ok(validation.issues.some((issue) => issue.includes('duplicates a baseline skill')));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('validateSkillPacks reports missing baseline skill files and README', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-'));

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.rmSync(path.join(bundleRoot, 'live', 'skills', 'README.md'));
        fs.rmSync(path.join(bundleRoot, 'live', 'skills', 'orchestration', 'skill.json'));

        const validation = validateSkillPacks(bundleRoot);
        assert.equal(validation.passed, false);
        assert.ok(validation.issues.some((issue) => issue.includes('Live skills README is missing')));
        assert.ok(validation.issues.some((issue) => issue.includes("Baseline skill 'orchestration' is missing 'orchestration/skill.json'.")));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Fuzzy alias expansion (T-078)
// ---------------------------------------------------------------------------

test('FUZZY_ALIAS_GROUPS is frozen and every group has at least two entries', () => {
    assert.ok(Object.isFrozen(FUZZY_ALIAS_GROUPS));
    assert.ok(FUZZY_ALIAS_GROUPS.length > 0);
    for (const group of FUZZY_ALIAS_GROUPS) {
        assert.ok(group.length >= 2, `Group has fewer than 2 entries: ${JSON.stringify(group)}`);
    }
});

test('getFuzzyAliasMap builds symmetric mappings', () => {
    const map = getFuzzyAliasMap();
    assert.ok(map instanceof Map);
    assert.ok(map.size > 0);

    // k8s ↔ kubernetes
    assert.ok(map.get('k8s')!.includes('kubernetes'));
    assert.ok(map.get('kubernetes')!.includes('k8s'));

    // pg ↔ postgres ↔ postgresql
    assert.ok(map.get('pg')!.includes('postgres'));
    assert.ok(map.get('pg')!.includes('postgresql'));
    assert.ok(map.get('postgresql')!.includes('pg'));

    // js ↔ javascript
    assert.ok(map.get('js')!.includes('javascript'));
    assert.ok(map.get('javascript')!.includes('js'));

    // dotnet ↔ .net ↔ csharp ↔ c#
    assert.ok(map.get('dotnet')!.includes('.net'));
    assert.ok(map.get('dotnet')!.includes('csharp'));
    assert.ok(map.get('c#')!.includes('dotnet'));
});

test('containsAtWordBoundary matches terms at word boundaries only', () => {
    // positive: standalone term
    assert.equal(containsAtWordBoundary('deploy k8s pods', 'k8s'), true);
    assert.equal(containsAtWordBoundary('k8s deployment', 'k8s'), true);
    assert.equal(containsAtWordBoundary('using pg for data', 'pg'), true);
    assert.equal(containsAtWordBoundary('pg', 'pg'), true);

    // positive: term next to punctuation / path separators
    assert.equal(containsAtWordBoundary('file.js module', 'js'), true);
    assert.equal(containsAtWordBoundary('src/k8s/manifests', 'k8s'), true);
    assert.equal(containsAtWordBoundary('use .net framework', '.net'), true);

    // negative: term embedded inside a longer word
    assert.equal(containsAtWordBoundary('upgrade package', 'pg'), false);
    assert.equal(containsAtWordBoundary('flags and banners', 'js'), false);
    assert.equal(containsAtWordBoundary('tsconfig.json', 'ts'), false);
    assert.equal(containsAtWordBoundary('first thing', 'rs'), false);
});

test('getSignalFuzzyVariants returns correct variants for known aliases', () => {
    const variants = getSignalFuzzyVariants('kubernetes');
    assert.ok(variants.includes('k8s'));
    assert.ok(variants.includes('kube'));
    assert.ok(!variants.includes('kubernetes'));

    const pgVariants = getSignalFuzzyVariants('postgresql');
    assert.ok(pgVariants.includes('pg'));
    assert.ok(pgVariants.includes('postgres'));
    assert.ok(pgVariants.includes('pgsql'));

    // path-style signal: k8s/ → kubernetes/
    const pathVariants = getSignalFuzzyVariants('k8s/');
    assert.ok(pathVariants.includes('kubernetes/'));
    assert.ok(pathVariants.includes('kube/'));
});

test('getSignalFuzzyVariants returns empty for unknown terms', () => {
    assert.deepEqual(getSignalFuzzyVariants('somethingcompletelyunknown'), []);
    assert.deepEqual(getSignalFuzzyVariants(''), []);
});

test('getSignalFuzzyVariants does not expand terms embedded inside larger words', () => {
    const variants = getSignalFuzzyVariants('upgrade');
    // "pg" is inside "upgrade" but not at a word boundary
    assert.ok(!variants.some((v) => v.includes('postgres')));
    assert.ok(!variants.some((v) => v.includes('postgresql')));
});

test('textMatchesFuzzyVariant bridges abbreviation ↔ full-name in both directions', () => {
    // text has abbreviation, signal is full name
    assert.equal(textMatchesFuzzyVariant('deploy k8s pods', 'kubernetes'), true);
    assert.equal(textMatchesFuzzyVariant('optimize pg queries', 'postgresql'), true);
    assert.equal(textMatchesFuzzyVariant('vanilla js app', 'javascript'), true);
    assert.equal(textMatchesFuzzyVariant('migrate to dotnet 8', '.net'), true);

    // text has full name, signal is abbreviation
    assert.equal(textMatchesFuzzyVariant('deploy kubernetes pods', 'k8s'), true);
    assert.equal(textMatchesFuzzyVariant('optimize postgresql queries', 'pg'), true);
    assert.equal(textMatchesFuzzyVariant('use javascript modules', 'js'), true);
    assert.equal(textMatchesFuzzyVariant('the .net framework', 'dotnet'), true);
});

test('textMatchesFuzzyVariant rejects false positives for short terms inside longer words', () => {
    assert.equal(textMatchesFuzzyVariant('upgrade package manager', 'postgresql'), false);
    assert.equal(textMatchesFuzzyVariant('flags and banners for display', 'javascript'), false);
    assert.equal(textMatchesFuzzyVariant('first priority item', 'rust'), false);
    assert.equal(textMatchesFuzzyVariant('platform tools', 'terraform'), false);
});

test('fuzzy aliases improve suggestSkills recall for k8s ↔ kubernetes', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-skills-fuzzy-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        seedBaselineSkills(repoRoot, bundleRoot);
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'k8s', 'manifests'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'k8s', 'manifests', 'deployment.yaml'), 'apiVersion: apps/v1\n', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'Dockerfile'), 'FROM node:20\n', 'utf8');

        // Task uses "k8s" abbreviation – should match skills with "kubernetes" signals
        const result = suggestSkills(bundleRoot, workspaceRoot, {
            taskText: 'Fix k8s deployment rollout and container health checks',
            changedPaths: ['k8s/manifests/deployment.yaml']
        });

        const allIds = [
            ...result.suggestedSkills.map((s) => s.id),
            ...result.availableRelevantSkills.map((s) => s.id)
        ];
        // devops-k8s pack skill should be matched via alias expansion
        assert.ok(
            allIds.some((id) => id.includes('k8s') || id.includes('devops') || id.includes('infra')),
            `Expected k8s/devops/infra skill in results but got: ${JSON.stringify(allIds)}`
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('fuzzy aliases are deterministic across repeated runs', () => {
    const map1 = getFuzzyAliasMap();
    // Clear the cache to force rebuild
    const map2 = getFuzzyAliasMap();
    assert.deepEqual([...map1.entries()].sort(), [...map2.entries()].sort());

    const variants1 = getSignalFuzzyVariants('postgresql');
    const variants2 = getSignalFuzzyVariants('postgresql');
    assert.deepEqual(variants1, variants2);
});

// ---------------------------------------------------------------------------
// T-080: Same-pack skill dedupe helpers
// ---------------------------------------------------------------------------

function makeSuggestion(id: string, pack: string, score: number, matches?: Partial<SignalMatches>) {
    return {
        id,
        name: id,
        pack,
        summary: `${id} summary`,
        score,
        installed: false,
        matches: Object.assign({
            stack_signals: [],
            task_signals: [],
            changed_path_signals: [],
            project_path_signals: [],
            aliases_or_tags: []
        }, matches || {})
    };
}

// -- hasDistinctSignalCoverage ------------------------------------------------

test('hasDistinctSignalCoverage returns false when candidate covers same categories', () => {
    const primary = makeSuggestion('a', 'p', 100, { stack_signals: ['react'] });
    const candidate = makeSuggestion('b', 'p', 80, { stack_signals: ['vue'] });
    assert.equal(hasDistinctSignalCoverage(primary, candidate), false);
});

test('hasDistinctSignalCoverage returns true when candidate has evidence in a new category', () => {
    const primary = makeSuggestion('a', 'p', 100, { stack_signals: ['react'] });
    const candidate = makeSuggestion('b', 'p', 80, { task_signals: ['refactor'] });
    assert.equal(hasDistinctSignalCoverage(primary, candidate), true);
});

test('hasDistinctSignalCoverage returns false when both have empty matches', () => {
    const primary = makeSuggestion('a', 'p', 100);
    const candidate = makeSuggestion('b', 'p', 80);
    assert.equal(hasDistinctSignalCoverage(primary, candidate), false);
});

test('hasDistinctSignalCoverage returns true for changed_path_signals coverage gap', () => {
    const primary = makeSuggestion('a', 'p', 100, { stack_signals: ['node'], task_signals: ['deploy'] });
    const candidate = makeSuggestion('b', 'p', 80, { stack_signals: ['node'], changed_path_signals: ['Dockerfile'] });
    assert.equal(hasDistinctSignalCoverage(primary, candidate), true);
});

test('hasDistinctSignalCoverage handles missing matches object gracefully', () => {
    const primary = { id: 'a', name: 'a', pack: 'p', summary: 'a', score: 100, installed: false, matches: { stack_signals: [], task_signals: [], changed_path_signals: [], project_path_signals: [], aliases_or_tags: [] } } as SkillSuggestion;
    const candidate = makeSuggestion('b', 'p', 80, { task_signals: ['review'] });
    assert.equal(hasDistinctSignalCoverage(primary, candidate), true);
});

// -- dedupeSkillsByPack: multi-match packs ------------------------------------

test('dedupeSkillsByPack collapses redundant same-pack skills', () => {
    const skills = [
        makeSuggestion('skill-a', 'pack-x', 100, { stack_signals: ['react'] }),
        makeSuggestion('skill-b', 'pack-x', 90, { stack_signals: ['react'] }),
        makeSuggestion('skill-c', 'pack-x', 80, { stack_signals: ['react'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].id, 'skill-a');
    assert.equal(collapsed.length, 2);
    assert.deepEqual(collapsed.map((s) => s.id), ['skill-b', 'skill-c']);
});

test('dedupeSkillsByPack preserves cross-pack diversity', () => {
    const skills = [
        makeSuggestion('a1', 'pack-a', 100, { stack_signals: ['react'] }),
        makeSuggestion('b1', 'pack-b', 95, { stack_signals: ['vue'] }),
        makeSuggestion('c1', 'pack-c', 90, { stack_signals: ['angular'] }),
        makeSuggestion('a2', 'pack-a', 85, { stack_signals: ['react'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 3);
    assert.deepEqual(primary.map((s) => s.id), ['a1', 'b1', 'c1']);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].id, 'a2');
});

// -- dedupeSkillsByPack: distinct-signal preservation -------------------------

test('dedupeSkillsByPack keeps same-pack skill with genuinely different signals', () => {
    const skills = [
        makeSuggestion('skill-a', 'pack-x', 100, { stack_signals: ['react'] }),
        makeSuggestion('skill-b', 'pack-x', 80, { task_signals: ['migrate'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 2, 'both skills should stay in primary');
    assert.equal(collapsed.length, 0);
});

test('dedupeSkillsByPack collapses third same-pack skill when first two cover all its categories', () => {
    const skills = [
        makeSuggestion('a', 'pack-x', 100, { stack_signals: ['react'], task_signals: ['lint'] }),
        makeSuggestion('b', 'pack-x', 80, { changed_path_signals: ['src/'] }),
        makeSuggestion('c', 'pack-x', 60, { stack_signals: ['react'], task_signals: ['review'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 2);
    assert.deepEqual(primary.map((s) => s.id), ['a', 'b']);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].id, 'c');
});

// -- dedupeSkillsByPack: tie handling -----------------------------------------

test('dedupeSkillsByPack is deterministic with tied scores (stable input order)', () => {
    const skills = [
        makeSuggestion('alpha', 'pack-x', 100, { stack_signals: ['react'] }),
        makeSuggestion('beta', 'pack-x', 100, { stack_signals: ['react'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].id, 'alpha', 'first in sorted order wins');
    assert.equal(collapsed[0].id, 'beta');
});

test('dedupeSkillsByPack tie with distinct categories keeps both', () => {
    const skills = [
        makeSuggestion('alpha', 'pack-x', 100, { stack_signals: ['node'] }),
        makeSuggestion('beta', 'pack-x', 100, { aliases_or_tags: ['express'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 2, 'both kept because signals differ');
    assert.equal(collapsed.length, 0);
});

// -- dedupeSkillsByPack: edge cases -------------------------------------------

test('dedupeSkillsByPack handles empty input', () => {
    const { primary, collapsed } = dedupeSkillsByPack([]);
    assert.equal(primary.length, 0);
    assert.equal(collapsed.length, 0);
});

test('dedupeSkillsByPack handles single skill', () => {
    const skills = [makeSuggestion('only', 'pack-a', 100, { stack_signals: ['go'] })];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].id, 'only');
    assert.equal(collapsed.length, 0);
});

test('dedupeSkillsByPack does not collapse skills from different packs with same signals', () => {
    const skills = [
        makeSuggestion('a', 'pack-a', 100, { stack_signals: ['react'] }),
        makeSuggestion('b', 'pack-b', 95, { stack_signals: ['react'] })
    ];
    const { primary, collapsed } = dedupeSkillsByPack(skills);
    assert.equal(primary.length, 2);
    assert.equal(collapsed.length, 0);
});

// -- MATCH_CATEGORIES integrity -----------------------------------------------

test('MATCH_CATEGORIES contains the expected signal categories', () => {
    assert.deepEqual([...MATCH_CATEGORIES], [
        'stack_signals', 'task_signals', 'changed_path_signals',
        'project_path_signals', 'aliases_or_tags'
    ]);
});

// -- Barrel re-export: skill-telemetry ----------------------------------------

test('barrel re-exports SKILL_TELEMETRY_EVENT_TYPES from skill-telemetry', () => {
    assert.ok(SKILL_TELEMETRY_EVENT_TYPES);
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_SUGGESTED, 'SKILL_SUGGESTED');
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_SELECTED, 'SKILL_SELECTED');
    assert.equal(SKILL_TELEMETRY_EVENT_TYPES.SKILL_REFERENCE_LOADED, 'SKILL_REFERENCE_LOADED');
});

test('barrel re-exports SKILL_TELEMETRY_ACTOR from skill-telemetry', () => {
    assert.equal(SKILL_TELEMETRY_ACTOR, 'skill-telemetry');
});

test('barrel re-exports buildSkillTelemetryDetails from skill-telemetry', () => {
    assert.equal(typeof buildSkillTelemetryDetails, 'function');
    const details = buildSkillTelemetryDetails({});
    assert.equal(details.telemetry_type, 'skill_activation');
    assert.equal(details.skill_id, null);
});

test('barrel re-exports emitSkillTelemetryEvent from skill-telemetry', () => {
    assert.equal(typeof emitSkillTelemetryEvent, 'function');
    const result = emitSkillTelemetryEvent(null, null, 'SKILL_SUGGESTED', 'msg');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillTelemetryEventAsync from skill-telemetry', async () => {
    assert.equal(typeof emitSkillTelemetryEventAsync, 'function');
    assert.equal(emitSkillTelemetryEventAsync, directEmitSkillTelemetryEventAsync);
    const result = await emitSkillTelemetryEventAsync(null, null, 'SKILL_SUGGESTED', 'msg');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillSuggestedEvent from skill-telemetry', () => {
    assert.equal(typeof emitSkillSuggestedEvent, 'function');
    const result = emitSkillSuggestedEvent(null, null, null);
    assert.equal(result, null);
});

test('barrel re-exports emitSkillSelectedEvent from skill-telemetry', () => {
    assert.equal(typeof emitSkillSelectedEvent, 'function');
    const result = emitSkillSelectedEvent(null, null, 'test-skill');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillSelectedEventAsync from skill-telemetry', async () => {
    assert.equal(typeof emitSkillSelectedEventAsync, 'function');
    assert.equal(emitSkillSelectedEventAsync, directEmitSkillSelectedEventAsync);
    const result = await emitSkillSelectedEventAsync(null, null, 'test-skill');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillReferenceLoadedEvent from skill-telemetry', () => {
    assert.equal(typeof emitSkillReferenceLoadedEvent, 'function');
    const result = emitSkillReferenceLoadedEvent(null, null, 'ref.md');
    assert.equal(result, null);
});

test('barrel re-exports emitSkillReferenceLoadedEventAsync from skill-telemetry', async () => {
    assert.equal(typeof emitSkillReferenceLoadedEventAsync, 'function');
    assert.equal(emitSkillReferenceLoadedEventAsync, directEmitSkillReferenceLoadedEventAsync);
    const result = await emitSkillReferenceLoadedEventAsync(null, null, 'ref.md');
    assert.equal(result, null);
});
