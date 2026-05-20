import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    getProjectDiscovery,
    buildProjectDiscoveryLines,
    buildDiscoveryOverlaySection,
    resolveSuggestedFullSuiteValidationCommand,
    STACK_SIGNALS,
    ProjectDiscovery
} from '../../../src/materialization/project-discovery';

describe('STACK_SIGNALS', () => {
    it('covers expected tech stacks', () => {
        const names = STACK_SIGNALS.map((s) => s.name);
        assert.ok(names.includes('Node.js or JavaScript'));
        assert.ok(names.includes('Python'));
        assert.ok(names.includes('Go'));
        assert.ok(names.includes('Rust'));
        assert.ok(names.includes('.NET'));
        assert.ok(names.includes('TypeScript'));
        assert.ok(names.includes('Java or JVM'));
    });
});

describe('getProjectDiscovery', () => {
    it('discovers stack signals from filesystem', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test');
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.go'), '');

            const result = getProjectDiscovery(tmpDir);
            assert.ok(result.source === 'filesystem_scan' || result.source === 'git_index_and_worktree');
            assert.ok(result.fileCount >= 2);
            assert.ok(result.detectedStacks.includes('Node.js or JavaScript'));
            assert.ok(result.detectedStacks.includes('Go'));
            assert.ok(result.suggestedCommands.length > 0);
            assert.equal(result.suggestedFullSuiteValidationCommand, 'npm test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('excludes garda-agent-orchestrator paths', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-excl-'));
        try {
            const gaoDir = path.join(tmpDir, 'garda-agent-orchestrator');
            fs.mkdirSync(gaoDir, { recursive: true });
            fs.writeFileSync(path.join(gaoDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Hello');

            const result = getProjectDiscovery(tmpDir);
            assert.ok(!result.detectedStacks.includes('Node.js or JavaScript'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects Java or JVM projects from common root files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-java-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project />');
            fs.writeFileSync(path.join(tmpDir, 'build.gradle.kts'), '');

            const result = getProjectDiscovery(tmpDir);
            assert.ok(result.detectedStacks.includes('Java or JVM'));
            assert.ok(result.stackEvidence.some((item) => item.name === 'Java or JVM'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('returns top-level directories excluding excluded ones', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-dirs-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.mkdirSync(path.join(tmpDir, '.git'));
            fs.mkdirSync(path.join(tmpDir, 'node_modules'));
            fs.mkdirSync(path.join(tmpDir, 'docs'));

            const result = getProjectDiscovery(tmpDir);
            assert.ok(result.topLevelDirectories.includes('src'));
            assert.ok(result.topLevelDirectories.includes('docs'));
            assert.ok(!result.topLevelDirectories.includes('.git'));
            assert.ok(!result.topLevelDirectories.includes('node_modules'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('resolveSuggestedFullSuiteValidationCommand', () => {
    it('prefers pnpm test when pnpm signals are present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-pnpm-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
                packageManager: 'pnpm@9.0.0',
                scripts: { test: 'vitest run' }
            }), 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir), 'pnpm test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers Maven wrapper when pom.xml and mvnw are present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-mvnw-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project />', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'mvnw'), '#!/bin/sh\n', 'utf8');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir), './mvnw test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers Maven cmd wrapper on Windows when pom.xml and mvnw.cmd are present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-mvnw-cmd-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project />', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'mvnw.cmd'), '@echo off\r\n', 'utf8');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir, 'win32'), '.\\mvnw.cmd test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers Gradle bat wrapper on Windows when gradle files and gradlew.bat are present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-gradlew-bat-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'build.gradle.kts'), 'plugins {}\n', 'utf8');
            fs.writeFileSync(path.join(tmpDir, 'gradlew.bat'), '@echo off\r\n', 'utf8');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir, 'win32'), '.\\gradlew.bat test');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does not fall back to npm test for unknown stacks', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-discovery-unknown-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Unknown\n', 'utf8');

            assert.equal(resolveSuggestedFullSuiteValidationCommand(tmpDir), null);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('buildProjectDiscoveryLines', () => {
    it('produces markdown with expected sections', () => {
        const discovery = {
            source: 'filesystem_scan',
            fileCount: 5,
            detectedStacks: ['Node.js or JavaScript'],
            stackEvidence: [{ name: 'Node.js or JavaScript', matches: ['package.json'] }],
            topLevelDirectories: ['src', 'docs'],
            rootFiles: ['package.json', 'README.md'],
            runtimePathHints: ['src/'],
            suggestedCommands: ['npm run test'],
            suggestedFullSuiteValidationCommand: 'pnpm test',
            sampleFiles: ['package.json', 'src/index.js']
        };
        const lines = buildProjectDiscoveryLines(discovery as unknown as ProjectDiscovery, '2025-01-01T00:00:00Z');
        const text = lines.join('\n');
        assert.ok(text.includes('# Project Discovery'));
        assert.ok(text.includes('## Detected Stack Signals'));
        assert.ok(text.includes('Node.js or JavaScript'));
        assert.ok(text.includes('## Top-Level Directories'));
        assert.ok(text.includes('## Stack Evidence'));
        assert.ok(text.includes('## Root Files'));
        assert.ok(text.includes('## Runtime Path Hints'));
        assert.ok(text.includes('## Suggested Local Commands'));
        assert.ok(text.includes('## Suggested Full-Suite Validation Command'));
        assert.ok(text.includes('pnpm test'));
        assert.ok(text.includes('## Sample Files Used'));
    });
});

describe('buildDiscoveryOverlaySection', () => {
    it('produces compact snapshot', () => {
        const discovery = {
            source: 'git_index_and_worktree',
            fileCount: 100,
            detectedStacks: ['Python', 'Go'],
            topLevelDirectories: ['src', 'cmd']
        };
        const result = buildDiscoveryOverlaySection(discovery as unknown as ProjectDiscovery);
        assert.ok(result.includes('## Project Discovery Snapshot'));
        assert.ok(result.includes('Python, Go'));
        assert.ok(result.includes('src, cmd'));
    });

    it('shows none detected for empty stacks', () => {
        const discovery = {
            source: 'filesystem_scan',
            fileCount: 0,
            detectedStacks: [],
            topLevelDirectories: []
        };
        const result = buildDiscoveryOverlaySection(discovery as unknown as ProjectDiscovery);
        assert.ok(result.includes('none detected'));
    });

    it('includes discovered full-suite command in the compact snapshot', () => {
        const discovery = {
            source: 'filesystem_scan',
            fileCount: 2,
            detectedStacks: ['Java or JVM'],
            topLevelDirectories: ['src'],
            suggestedFullSuiteValidationCommand: './gradlew test'
        };
        const result = buildDiscoveryOverlaySection(discovery as unknown as ProjectDiscovery);
        assert.ok(result.includes('Suggested full-suite validation command: `./gradlew test`'));
    });

    it('keeps unknown stack full-suite guidance unconfigured in the compact snapshot', () => {
        const discovery = {
            source: 'filesystem_scan',
            fileCount: 1,
            detectedStacks: [],
            topLevelDirectories: [],
            suggestedFullSuiteValidationCommand: null
        };
        const result = buildDiscoveryOverlaySection(discovery as unknown as ProjectDiscovery);
        assert.ok(result.includes('keep workflow-config unconfigured'));
    });
});
