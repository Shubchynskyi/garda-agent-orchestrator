import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleSkills } from '../../../../src/cli/commands/skills';
import { getSkillPacksConfigPath, getSkillsHeadlinesConfigPath, writeSkillsIndex } from '../../../../src/runtime/skills';

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

test('handleSkills suggest prints deterministic recommendation output', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cli-skills-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');
    const packageJson = { name: 'test-pkg', version: '1.0.8' };
    const originalLog = console.log;
    const lines: string[] = [];

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'components'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"web-app","dependencies":{"react":"18.0.0"}}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'components', 'App.tsx'), 'export function App() { return null; }\n', 'utf8');

        console.log = function (...items: unknown[]) {
            lines.push(items.join(' '));
        };

        const result = handleSkills([
            'suggest',
            '--bundle-root', bundleRoot,
            '--target-root', workspaceRoot,
            '--task-text', 'Improve component accessibility and rendering performance',
            '--changed-path', 'src/components/App.tsx'
        ], packageJson);

        assert.ok(result != null && 'suggestedPacks' in result);
        assert.ok(result.suggestedPacks.some((pack: { id: string }) => pack.id === 'frontend-react'));
        assert.ok(result.suggestedSkills.some((skill: { id: string }) => skill.id === 'frontend-react'));
        const output = lines.join('\n');
        assert.match(output, /GARDA_SKILLS/);
        assert.match(output, /Action: suggest/);
        assert.match(output, /PackVsSkill:/);
        assert.match(output, /BaselineSkills:/);
        assert.match(output, /Suggested Optional Packs To Add/);
        assert.match(output, /Suggested Skills To Add/);
    } finally {
        console.log = originalLog;
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('handleSkills list surfaces the compact headlines artifact path', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cli-skills-list-'));
    const packageJson = { name: 'test-pkg', version: '1.0.8' };
    const originalLog = console.log;
    const lines: string[] = [];

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        console.log = function (...items: unknown[]) {
            lines.push(items.join(' '));
        };

        const result = handleSkills([
            'list',
            '--bundle-root', bundleRoot
        ], packageJson);

        assert.ok(result != null && 'headlinesPath' in result);
        const output = lines.join('\n');
        assert.match(output, /GARDA_SKILLS/);
        assert.match(output, /Action: list/);
        assert.match(output, /HeadlinesPath:/);
        assert.match(output, /Ready Optional Packs/);
    } finally {
        console.log = originalLog;
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('handleSkills suggest does not self-heal missing headlines for a read-only query', () => {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cli-skills-suggest-readonly-'));
    const workspaceRoot = path.join(bundleRoot, 'workspace');
    const packageJson = { name: 'test-pkg', version: '1.0.8' };

    try {
        fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
        fs.cpSync(path.join(repoRoot, 'template', 'skill-packs'), path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'template', 'config', 'skill-packs.json'), getSkillPacksConfigPath(bundleRoot));
        writeSkillsIndex(bundleRoot);

        fs.mkdirSync(path.join(workspaceRoot, 'src', 'components'), { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"web-app","dependencies":{"react":"18.0.0"}}', 'utf8');
        fs.writeFileSync(path.join(workspaceRoot, 'src', 'components', 'App.tsx'), 'export function App() { return null; }\n', 'utf8');

        const headlinesPath = getSkillsHeadlinesConfigPath(bundleRoot);
        fs.rmSync(headlinesPath, { force: true });

        const result = handleSkills([
            'suggest',
            '--bundle-root', bundleRoot,
            '--target-root', workspaceRoot,
            '--task-text', 'Improve component accessibility and rendering performance',
            '--changed-path', 'src/components/App.tsx'
        ], packageJson);

        assert.ok(result != null && 'suggestedPacks' in result);
        assert.equal(fs.existsSync(headlinesPath), false);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});
