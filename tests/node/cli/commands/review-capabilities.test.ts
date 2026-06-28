import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleReviewCapabilities } from '../../../../src/cli/commands/review-capabilities-command';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

type LiveSkillSeed = string | {
    id: string;
    skillMd?: boolean;
    skillJson?: boolean;
};

function createBundleRoot(options: {
    config?: Record<string, boolean> | null;
    liveSkills?: LiveSkillSeed[];
    builtinPacks?: Array<{ id: string; skillIds: string[] }>;
} = {}): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-review-capabilities-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    const liveSkillsRoot = path.join(bundleRoot, 'live', 'skills');
    const templateSkillPacksRoot = path.join(bundleRoot, 'template', 'skill-packs');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(liveSkillsRoot, { recursive: true });
    fs.mkdirSync(templateSkillPacksRoot, { recursive: true });

    if (options.config !== null) {
        fs.writeFileSync(
            path.join(configDir, 'review-capabilities.json'),
            JSON.stringify(options.config || {
                code: true,
                db: true,
                security: true,
                refactor: true,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }, null, 2),
            'utf8'
        );
    }

    for (const pack of options.builtinPacks || []) {
        const packRoot = path.join(templateSkillPacksRoot, pack.id);
        fs.mkdirSync(path.join(packRoot, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(packRoot, 'pack.json'), JSON.stringify({
            id: pack.id,
            label: pack.id,
            description: `${pack.id} pack`,
            tags: [],
            recommended_for: []
        }, null, 2), 'utf8');

        for (const skillId of pack.skillIds) {
            const skillRoot = path.join(packRoot, 'skills', skillId);
            fs.mkdirSync(skillRoot, { recursive: true });
            fs.writeFileSync(path.join(skillRoot, 'skill.json'), JSON.stringify({
                id: skillId,
                name: skillId,
                pack: pack.id,
                summary: `${skillId} summary`,
                tags: [],
                aliases: [],
                stack_signals: [],
                task_signals: [],
                changed_path_signals: [],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'never'
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `# ${skillId}\n`, 'utf8');
        }
    }

    for (const liveSkill of options.liveSkills || []) {
        const seed = typeof liveSkill === 'string'
            ? { id: liveSkill, skillMd: true, skillJson: false }
            : { skillMd: true, skillJson: false, ...liveSkill };
        const skillRoot = path.join(liveSkillsRoot, seed.id);
        fs.mkdirSync(skillRoot, { recursive: true });
        if (seed.skillMd !== false) {
            fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `# ${seed.id}\n`, 'utf8');
        }
        if (seed.skillJson === true) {
            fs.writeFileSync(path.join(skillRoot, 'skill.json'), JSON.stringify({
                id: seed.id,
                name: seed.id,
                summary: `${seed.id} summary`
            }, null, 2), 'utf8');
        }
    }

    return bundleRoot;
}

function captureConsole<T>(run: () => T): { result: T; output: string } {
    const originalConsoleLog = console.log;
    const lines: string[] = [];
    console.log = (...items: unknown[]) => {
        lines.push(items.join(' '));
    };
    try {
        return {
            result: run(),
            output: lines.join('\n')
        };
    } finally {
        console.log = originalConsoleLog;
    }
}

test('review-capabilities show prints supported optional capabilities and manual-only live skills', () => {
    const bundleRoot = createBundleRoot({
        config: {
            code: true,
            db: true,
            security: true,
            refactor: true,
            api: true,
            test: false,
            performance: false,
            infra: false,
            dependency: true
        },
        liveSkills: ['api-contract-review', 'dependency-review', 'architecture-review']
    });

    try {
        const { result, output } = captureConsole(() => handleReviewCapabilities(['show', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.ok(output.includes('GARDA_REVIEW_CAPABILITIES'));
        assert.ok(output.includes('Enabled optional reviews: api, dependency'));
        assert.ok(output.includes('ManualOnlyLiveSkills: architecture-review'));
        assert.ok(output.includes('api: enabled=true'));
        assert.ok(output.includes('dependency: enabled=true'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('review-capabilities defaults to show when the subcommand is omitted', () => {
    const bundleRoot = createBundleRoot({
        config: null,
        liveSkills: ['testing-strategy']
    });

    try {
        const { result, output } = captureConsole(() => handleReviewCapabilities(['--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.equal(result.config_exists, false);
        assert.ok(output.includes('Action: show'));
        assert.ok(output.includes('Enabled optional reviews: api, test, performance, infra, dependency'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('review-capabilities list aliases show', () => {
    const bundleRoot = createBundleRoot({
        config: null,
        liveSkills: ['testing-strategy']
    });

    try {
        const { result, output } = captureConsole(() => handleReviewCapabilities(['list', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.equal(result.config_exists, false);
        assert.ok(output.includes('Action: show'));
        assert.ok(output.includes('Enabled optional reviews: api, test, performance, infra, dependency'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('review-capabilities show --json returns valid machine-readable output', () => {
    const bundleRoot = createBundleRoot({
        config: {
            code: true,
            db: true,
            security: true,
            refactor: true,
            api: false,
            test: true,
            performance: false,
            infra: false,
            dependency: false
        },
        liveSkills: ['testing-strategy']
    });

    try {
        const { output } = captureConsole(() => handleReviewCapabilities(['show', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
        const parsed = JSON.parse(output);
        assert.equal(parsed.action, 'show');
        assert.equal(parsed.visible_summary_line, 'Enabled optional reviews: test');
        assert.equal(parsed.capabilities.find((entry: { capability: string }) => entry.capability === 'test').live_skill_present, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('review-capabilities enable updates repo-local config deterministically', () => {
    const bundleRoot = createBundleRoot({
        liveSkills: ['api-contract-review', 'testing-strategy']
    });
    const configPath = path.join(bundleRoot, 'live', 'config', 'review-capabilities.json');

    try {
        const { output } = captureConsole(() => handleReviewCapabilities([
            'enable',
            '--bundle-root', bundleRoot,
            '--json',
            'api',
            'test'
        ], PACKAGE_JSON));
        const parsed = JSON.parse(output);
        assert.equal(parsed.action, 'enable');
        assert.equal(parsed.status, 'CHANGED');
        assert.deepEqual(parsed.requested_capabilities, ['api', 'test']);
        assert.equal(parsed.enabled_capabilities.includes('api'), true);
        assert.equal(parsed.enabled_capabilities.includes('test'), true);

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.api, true);
        assert.equal(parsedConfig.test, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('review-capabilities enable rejects missing matching live skill', () => {
    const bundleRoot = createBundleRoot({
        liveSkills: ['architecture-review']
    });

    try {
        assert.throws(
            () => handleReviewCapabilities(['enable', '--bundle-root', bundleRoot, 'performance'], PACKAGE_JSON),
            /Cannot enable review capability 'performance' because no matching live skill is installed/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('review-capabilities enable does not treat a bare matching directory as an installed live skill', () => {
    const bundleRoot = createBundleRoot({
        liveSkills: [
            { id: 'performance-review', skillMd: false, skillJson: false }
        ]
    });

    try {
        const { result } = captureConsole(() => handleReviewCapabilities(['show', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
        assert.ok(typeof result === 'object' && result !== null && result.action === 'show');
        const performanceStatus = result.capabilities.find((entry) => entry.capability === 'performance');
        assert.ok(performanceStatus);
        assert.equal(performanceStatus.matching_live_skill_ready, false);
        assert.deepEqual(performanceStatus.matching_live_skill_ids, []);
        assert.deepEqual(result.available_live_skills, ['performance-review']);

        assert.throws(
            () => handleReviewCapabilities(['enable', '--bundle-root', bundleRoot, 'performance'], PACKAGE_JSON),
            /A bare directory without SKILL\.md or skill\.json does not count/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('review-capabilities show keeps only unsupported custom live skills in manual-only output', () => {
    const bundleRoot = createBundleRoot({
        liveSkills: [
            'orchestration',
            'orchestration-depth1',
            'skill-builder',
            'spring-service',
            'architecture-review',
            { id: 'loose-dir', skillMd: false, skillJson: false }
        ],
        builtinPacks: [
            { id: 'java-spring', skillIds: ['spring-service'] }
        ]
    });

    try {
        const { result, output } = captureConsole(() => handleReviewCapabilities(['show', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.deepEqual(result.manual_only_live_skills, ['architecture-review']);
        assert.ok(output.includes('ManualOnlyLiveSkills: architecture-review'));
        assert.equal(output.includes('ManualOnlyLiveSkills: orchestration'), false);
        assert.equal(output.includes('ManualOnlyLiveSkills: loose-dir'), false);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('review-capabilities disable preserves unknown future capability keys', () => {
    const bundleRoot = createBundleRoot({
        config: {
            code: true,
            db: true,
            security: true,
            refactor: true,
            api: true,
            test: false,
            performance: false,
            infra: false,
            dependency: false,
            custom_future: true
        }
    });
    const configPath = path.join(bundleRoot, 'live', 'config', 'review-capabilities.json');

    try {
        const { result, output } = captureConsole(() => handleReviewCapabilities(['disable', '--bundle-root', bundleRoot, 'api'], PACKAGE_JSON));
        assert.ok(result && result.action === 'disable');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Status: CHANGED'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.api, false);
        assert.equal(parsedConfig.custom_future, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});
