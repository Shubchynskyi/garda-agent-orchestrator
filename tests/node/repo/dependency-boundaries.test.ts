import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    DEPENDENCY_LAYER_NAMES,
    DEPENDENCY_LAYER_POLICY,
    inspectDependencyBoundaries
} from '../../../scripts/node-foundation/dependency-boundaries';
import { getRepoRoot } from '../../../scripts/node-foundation/build';

function writeFixtureFile(repoRoot: string, relativePath: string, contents: string): void {
    const absolutePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, 'utf8');
}

test('dependency policy explicitly decides every governed layer edge and import kind', () => {
    for (const sourceLayer of DEPENDENCY_LAYER_NAMES) {
        assert.deepEqual(Object.keys(DEPENDENCY_LAYER_POLICY[sourceLayer]).sort(), [...DEPENDENCY_LAYER_NAMES].sort());
        for (const targetLayer of DEPENDENCY_LAYER_NAMES) {
            assert.equal(typeof DEPENDENCY_LAYER_POLICY[sourceLayer][targetLayer].runtime, 'boolean');
            assert.equal(typeof DEPENDENCY_LAYER_POLICY[sourceLayer][targetLayer].typeOnly, 'boolean');
        }
    }

    assert.deepEqual(DEPENDENCY_LAYER_POLICY['gate-runtime'].gates, {
        runtime: false,
        typeOnly: false
    });
    assert.deepEqual(DEPENDENCY_LAYER_POLICY.core.gates, {
        runtime: false,
        typeOnly: false
    });
    assert.deepEqual(DEPENDENCY_LAYER_POLICY.core.cli, {
        runtime: false,
        typeOnly: false
    });
});

test('dependency inspection reports forbidden source and target layers for runtime and type-only imports', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dependency-boundaries-negative-'));
    try {
        writeFixtureFile(repoRoot, 'src/core/runtime.ts', "import { gateValue } from '../gates/gate-value';\nexport { gateValue };\n");
        writeFixtureFile(repoRoot, 'src/core/type-contract.ts', "export type { CliContract } from '../cli/cli-contract';\n");
        writeFixtureFile(repoRoot, 'src/gate-runtime/runtime.ts', "import type { GateContract } from '../gates/gate-contract';\nexport type RuntimeContract = GateContract;\n");
        writeFixtureFile(repoRoot, 'src/gates/gate-value.ts', 'export const gateValue = 1;\n');
        writeFixtureFile(repoRoot, 'src/gates/gate-contract.ts', 'export interface GateContract { value: string; }\n');
        writeFixtureFile(repoRoot, 'src/cli/cli-contract.ts', 'export interface CliContract { value: string; }\n');

        const result = inspectDependencyBoundaries({ repoRoot });

        assert.equal(result.violations.length, 3);
        assert.deepEqual(
            result.violations.map((violation) => ({
                sourceLayer: violation.sourceLayer,
                targetLayer: violation.targetLayer,
                importKind: violation.importKind
            })),
            [
                { sourceLayer: 'core', targetLayer: 'gates', importKind: 'runtime' },
                { sourceLayer: 'core', targetLayer: 'cli', importKind: 'type-only' },
                { sourceLayer: 'gate-runtime', targetLayer: 'gates', importKind: 'type-only' }
            ]
        );
        for (const violation of result.violations) {
            assert.match(violation.message, new RegExp(`${violation.sourceLayer} -> ${violation.targetLayer}`, 'u'));
            assert.match(violation.message, /src\//u);
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('dependency inspection accepts explicitly allowed edges and the migrated repository tree', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dependency-boundaries-positive-'));
    try {
        writeFixtureFile(fixtureRoot, 'src/core/core-value.ts', 'export const coreValue = 1;\n');
        writeFixtureFile(fixtureRoot, 'src/core/node-runtime.ts', "export { basename } from 'node:path';\n");
        writeFixtureFile(fixtureRoot, 'src/gate-runtime/runtime-value.ts', "export { coreValue } from '../core/core-value';\n");
        writeFixtureFile(fixtureRoot, 'src/core/runtime-bridge.ts', "export { coreValue } from '../gate-runtime/runtime-value';\n");
        writeFixtureFile(fixtureRoot, 'src/gates/gate-value.ts', "export { coreValue } from '../gate-runtime/runtime-value';\n");
        writeFixtureFile(fixtureRoot, 'src/cli/cli-value.ts', "export { coreValue } from '../gates/gate-value';\n");

        assert.deepEqual(inspectDependencyBoundaries({ repoRoot: fixtureRoot }).violations, []);
        assert.deepEqual(inspectDependencyBoundaries({ repoRoot: getRepoRoot() }).violations, []);
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('dependency inspection fails closed for unresolved relative imports', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dependency-boundaries-unresolved-'));
    try {
        writeFixtureFile(repoRoot, 'src/core/broken.ts', "export { missing } from './missing-module';\n");

        const result = inspectDependencyBoundaries({ repoRoot });

        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0].violationKind, 'unresolved-relative-import');
        assert.equal(result.violations[0].sourceLayer, 'core');
        assert.equal(result.violations[0].targetLayer, 'unresolved');
        assert.match(result.violations[0].message, /core -> unresolved/u);
        assert.match(result.violations[0].message, /\.\/missing-module/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('dependency inspection fails closed for unresolved bare imports', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dependency-boundaries-unresolved-bare-'));
    try {
        writeFixtureFile(repoRoot, 'src/core/broken.ts', "export { missing } from 'unresolved-workspace-alias';\n");

        const result = inspectDependencyBoundaries({ repoRoot });

        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0].violationKind, 'unresolved-bare-import');
        assert.equal(result.violations[0].sourceLayer, 'core');
        assert.equal(result.violations[0].targetLayer, 'unresolved');
        assert.match(result.violations[0].message, /unresolved-workspace-alias/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('dependency inspection enforces dynamic imports that include import options', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dependency-boundaries-dynamic-options-'));
    try {
        writeFixtureFile(
            repoRoot,
            'src/gate-runtime/runtime.ts',
            "export async function loadGate(): Promise<unknown> {\n    return import('../gates/gate-value', { with: { type: 'json' } });\n}\n"
        );
        writeFixtureFile(repoRoot, 'src/gates/gate-value.ts', 'export const gateValue = 1;\n');

        const result = inspectDependencyBoundaries({ repoRoot });

        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0].violationKind, 'forbidden-layer-edge');
        assert.equal(result.violations[0].sourceLayer, 'gate-runtime');
        assert.equal(result.violations[0].targetLayer, 'gates');
        assert.equal(result.violations[0].importKind, 'runtime');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('dependency inspection enforces module-bound CommonJS require calls', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dependency-boundaries-module-require-'));
    try {
        writeFixtureFile(
            repoRoot,
            'src/gate-runtime/runtime.ts',
            "export const gateModule = module.require('../gates/gate-value');\n"
        );
        writeFixtureFile(repoRoot, 'src/gates/gate-value.ts', 'export const gateValue = 1;\n');

        const result = inspectDependencyBoundaries({ repoRoot });

        assert.equal(result.violations.length, 1);
        assert.equal(result.violations[0].violationKind, 'forbidden-layer-edge');
        assert.equal(result.violations[0].sourceLayer, 'gate-runtime');
        assert.equal(result.violations[0].targetLayer, 'gates');
        assert.equal(result.violations[0].importKind, 'runtime');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('normal typecheck verification runs the dependency boundary check', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    assert.equal(
        scripts['validate:dependencies'],
        'node scripts/node-foundation/build-scripts.cjs check-dependencies.js'
    );
    assert.equal(
        scripts.typecheck,
        'npm run validate:dependencies && tsc -p tsconfig.node-foundation.json'
    );
});
