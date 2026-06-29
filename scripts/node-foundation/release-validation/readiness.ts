import * as path from 'node:path';

import { getRepoRoot } from '../build';
import {
    PUBLIC_PACKAGE_DOC_ITEMS,
    RELEASE_READINESS_CHECKLIST_PATH,
    SECURITY_RELEASE_DOC_ITEMS,
    SOURCEFUL_PACKAGE_SURFACE_ITEMS,
    type ReleaseReadinessCheck,
    type ReleaseReadinessResult
} from './types';
import {
    countOccurrences,
    escapeRegExp,
    fileExists,
    getStringArray,
    getStringRecord,
    isGitTracked,
    manifestListsEvery,
    pushCheck,
    readPackageJsonObject,
    readTextFileIfExists
} from './shared';

function extractReleaseChecklistItems(checklistMarkdown: string, version: string): {
    releaseChecklistItems: string[];
    openReleaseChecklistItems: string[];
} {
    const releaseChecklistItems: string[] = [];
    const openReleaseChecklistItems: string[] = [];
    let inVersionSection = false;
    const sectionPattern = new RegExp(`^##\\s+${escapeRegExp(version)}(?:\\s|$)`, 'u');

    for (const line of checklistMarkdown.split(/\r?\n/u)) {
        if (sectionPattern.test(line)) {
            inVersionSection = true;
            continue;
        }
        if (inVersionSection && /^##\s+/u.test(line)) {
            break;
        }
        if (!inVersionSection) {
            continue;
        }

        const match = line.match(/^-\s+\[(x|X| )\]\s+(.+?)\s*$/u);
        if (!match) {
            continue;
        }
        const item = match[2];
        releaseChecklistItems.push(item);
        if (match[1] === ' ') {
            openReleaseChecklistItems.push(item);
        }
    }

    return { releaseChecklistItems, openReleaseChecklistItems };
}

function validateReleaseChecklist(repoRoot: string, version: string | null): {
    releaseChecklistItems: string[];
    openReleaseChecklistItems: string[];
    details: string[];
} {
    const checklistPath = path.join(repoRoot, ...RELEASE_READINESS_CHECKLIST_PATH.split('/'));
    const checklistMarkdown = readTextFileIfExists(checklistPath);
    if (checklistMarkdown === null) {
        return {
            releaseChecklistItems: [],
            openReleaseChecklistItems: [],
            details: [`Missing tracked release checklist: ${RELEASE_READINESS_CHECKLIST_PATH}`]
        };
    }
    if (!isGitTracked(repoRoot, RELEASE_READINESS_CHECKLIST_PATH)) {
        return {
            releaseChecklistItems: [],
            openReleaseChecklistItems: [],
            details: [`Untracked release checklist: ${RELEASE_READINESS_CHECKLIST_PATH}`]
        };
    }

    const targetVersion = version || 'unknown';
    const { releaseChecklistItems, openReleaseChecklistItems } = extractReleaseChecklistItems(
        checklistMarkdown,
        targetVersion
    );
    const details = [
        `Release ${targetVersion} checklist items: ${releaseChecklistItems.length}`,
        `Open checklist items: ${openReleaseChecklistItems.length === 0 ? 'none' : openReleaseChecklistItems.join('; ')}`
    ];

    if (releaseChecklistItems.length === 0) {
        details.push(`No checklist items were found in the Release ${targetVersion} section.`);
    }

    return { releaseChecklistItems, openReleaseChecklistItems, details };
}

function getWorkflowJobBlock(workflowText: string, jobId: string): string | null {
    const lines = workflowText.split(/\r?\n/u);
    const jobPattern = new RegExp(`^(\\s*)${jobId}:\\s*$`, 'u');
    const jobStart = lines.findIndex((line) => jobPattern.test(line));
    if (jobStart === -1) {
        return null;
    }
    const jobIndent = jobPattern.exec(lines[jobStart])![1].length;
    const nextJobPattern = new RegExp(`^\\s{${jobIndent}}[A-Za-z0-9_-]+:\\s*$`, 'u');
    const nextJob = lines.findIndex((line, index) => index > jobStart && nextJobPattern.test(line));
    return lines.slice(jobStart, nextJob === -1 ? undefined : nextJob).join('\n');
}

function extractYamlListAfterKey(block: string | null, key: string): string[] {
    if (block === null) {
        return [];
    }
    const lines = block.split(/\r?\n/u);
    const keyPattern = new RegExp(`^(\\s*)${key}:\\s*$`, 'u');
    const keyIndex = lines.findIndex((line) => keyPattern.test(line));
    if (keyIndex === -1) {
        return [];
    }
    const keyIndent = keyPattern.exec(lines[keyIndex])![1].length;
    const values: string[] = [];
    for (const line of lines.slice(keyIndex + 1)) {
        const indent = line.match(/^\s*/u)![0].length;
        if (line.trim() && indent <= keyIndent) {
            break;
        }
        const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
        if (item) {
            values.push(item[1].replace(/^['"]|['"]$/gu, ''));
        }
    }
    return values;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workflowJobHasRunStep(block: string | null, command: string): boolean {
    if (block === null) {
        return false;
    }
    const runScripts = extractWorkflowRunScripts(block);
    return runScripts.some((script) => scriptHasExecutableCommand(script, command));
}

function workflowHasUseStep(workflowText: string, actionReference: string): boolean {
    for (const line of workflowText.split(/\r?\n/u)) {
        const match = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/u.exec(line);
        if (!match) {
            continue;
        }
        if (stripYamlQuotes(match[1].trim()) === actionReference) {
            return true;
        }
    }
    return false;
}

function getYamlKeyBlock(block: string | null, key: string): string | null {
    if (block === null) {
        return null;
    }
    const lines = block.split(/\r?\n/u);
    const keyPattern = new RegExp(`^(\\s*)${key}:\\s*(?:[|>][+-]?)?\\s*$`, 'u');
    const keyIndex = lines.findIndex((line) => keyPattern.test(line));
    if (keyIndex === -1) {
        return null;
    }
    const keyIndent = keyPattern.exec(lines[keyIndex])![1].length;
    let endIndex = lines.length;
    for (let index = keyIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() && line.match(/^\s*/u)![0].length <= keyIndent) {
            endIndex = index;
            break;
        }
    }
    return lines.slice(keyIndex, endIndex).join('\n');
}

function getWorkflowUseStepBlock(workflowText: string, actionReference: string): string | null {
    const lines = workflowText.split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const usesMatch = /^(\s*)(?:-\s*)?uses:\s*(.+?)\s*$/u.exec(line);
        if (!usesMatch || stripYamlQuotes(usesMatch[2].trim()) !== actionReference) {
            continue;
        }

        const usesIndent = usesMatch[1].length;
        const inlineStepMatch = /^(\s*)-\s+uses:/u.exec(line);
        let stepStart = inlineStepMatch ? index : -1;
        let stepIndent = inlineStepMatch ? inlineStepMatch[1].length : -1;
        for (let previousIndex = index - 1; stepStart === -1 && previousIndex >= 0; previousIndex -= 1) {
            const previousLine = lines[previousIndex];
            const previousStep = /^(\s*)-\s+/u.exec(previousLine);
            if (previousStep && previousStep[1].length < usesIndent) {
                stepStart = previousIndex;
                stepIndent = previousStep[1].length;
            }
        }
        if (stepStart === -1) {
            return null;
        }

        let stepEnd = lines.length;
        for (let nextIndex = stepStart + 1; nextIndex < lines.length; nextIndex += 1) {
            const nextLine = lines[nextIndex];
            if (nextLine.trim() && nextLine.match(/^\s*/u)![0].length <= stepIndent) {
                stepEnd = nextIndex;
                break;
            }
        }
        return lines.slice(stepStart, stepEnd).join('\n');
    }

    return null;
}

function blockHasNonCommentLine(block: string | null, expectedLine: string): boolean {
    return (block || '').split(/\r?\n/u)
        .some((line) => {
            const trimmed = line.trim();
            return trimmed !== '' && !trimmed.startsWith('#') && trimmed === expectedLine;
        });
}

function scriptHasExecutableCommand(script: string, command: string): boolean {
    let hereDocTerminator: string | null = null;

    for (const line of script.split(/\r?\n/u)) {
        const trimmedLine = line.trim();
        if (hereDocTerminator !== null) {
            if (trimmedLine === hereDocTerminator) {
                hereDocTerminator = null;
            }
            continue;
        }
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            continue;
        }
        if (trimmedLine === command || trimmedLine.startsWith(`${command} `)) {
            return true;
        }
        hereDocTerminator = extractHereDocTerminator(trimmedLine);
    }

    return false;
}

function extractHereDocTerminator(line: string): string | null {
    const match = /(?:^|\s)<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_.-]*))/u.exec(line);
    return match ? match[1] || match[2] || match[3] : null;
}

function extractWorkflowRunScripts(block: string): string[] {
    const scripts: string[] = [];
    const lines = block.split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const inlineRun = /^(\s*)-\s+run:\s*(.+?)\s*$/u.exec(line)
            || /^(\s*)run:\s*(.+?)\s*$/u.exec(line);
        if (!inlineRun) {
            continue;
        }

        const runIndent = inlineRun[1].length;
        const runValue = inlineRun[2].trim();
        if (!/^[|>][+-]?$/u.test(runValue)) {
            scripts.push(stripYamlQuotes(runValue));
            continue;
        }

        const scriptLines: string[] = [];
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
            const nextLine = lines[nextIndex];
            if (nextLine.trim() && nextLine.match(/^\s*/u)![0].length <= runIndent) {
                break;
            }
            scriptLines.push(nextLine.trim());
            index = nextIndex;
        }
        scripts.push(scriptLines.join('\n'));
    }

    return scripts;
}

function stripYamlQuotes(value: string): string {
    return value.replace(/^['"]|['"]$/gu, '');
}

function validateCiRuntimeMatrixContract(ciWorkflow: string): { passed: boolean; details: string[] } {
    const releaseJob = getWorkflowJobBlock(ciWorkflow, 'validate-release');
    const smokeJob = getWorkflowJobBlock(ciWorkflow, 'smoke');
    const testUnitJob = getWorkflowJobBlock(ciWorkflow, 'test-unit');
    const testGatesJob = getWorkflowJobBlock(ciWorkflow, 'test-gates');
    const testCliJob = getWorkflowJobBlock(ciWorkflow, 'test-cli');
    const testLifecycleJob = getWorkflowJobBlock(ciWorkflow, 'test-lifecycle');
    const testBinJob = getWorkflowJobBlock(ciWorkflow, 'test-bin');
    const supportedNodeLines = ['22.13.0', '24'];
    const releaseOsLines = ['ubuntu-latest', 'windows-latest'];
    const smokeOsLines = ['ubuntu-latest', 'windows-latest', 'macos-latest'];
    const releaseNodeVersions = extractYamlListAfterKey(releaseJob, 'node-version');
    const smokeNodeVersions = extractYamlListAfterKey(smokeJob, 'node-version');
    const releaseOsVersions = extractYamlListAfterKey(releaseJob, 'os');
    const smokeOsVersions = extractYamlListAfterKey(smokeJob, 'os');
    const testUnitOk = testUnitJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testUnitJob, 'node-version'), supportedNodeLines);
    const testGatesOk = testGatesJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testGatesJob, 'node-version'), supportedNodeLines)
        && testGatesJob.includes('GARDA_NODE_FOUNDATION_TEST_SHARDS');
    const testCliOk = testCliJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testCliJob, 'node-version'), supportedNodeLines)
        && testCliJob.includes('GARDA_NODE_FOUNDATION_TEST_SHARDS');
    const testLifecycleOk = testLifecycleJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testLifecycleJob, 'node-version'), supportedNodeLines);
    const testBinOk = testBinJob !== null
        && stringArraysEqual(extractYamlListAfterKey(testBinJob, 'node-version'), supportedNodeLines);
    const releaseMatrixOk = stringArraysEqual(releaseNodeVersions, supportedNodeLines)
        && stringArraysEqual(releaseOsVersions, releaseOsLines)
        && (workflowJobHasRunStep(releaseJob, 'npm run validate:release:fast') || workflowJobHasRunStep(releaseJob, 'npm run validate:release'));
    const smokeMatrixOk = stringArraysEqual(smokeNodeVersions, supportedNodeLines)
        && stringArraysEqual(smokeOsVersions, smokeOsLines)
        && workflowJobHasRunStep(smokeJob, '$CLI setup')
        && workflowJobHasRunStep(smokeJob, '$CLI update git')
        && workflowJobHasRunStep(smokeJob, '$CLI doctor')
        && workflowJobHasRunStep(smokeJob, '$CLI uninstall');
    return {
        passed: releaseMatrixOk && smokeMatrixOk && testUnitOk && testGatesOk && testCliOk && testLifecycleOk && testBinOk,
        details: [
            `test-unit present=${testUnitOk}`,
            `test-gates present+sharded=${testGatesOk}`,
            `test-cli present+sharded=${testCliOk}`,
            `test-lifecycle present=${testLifecycleOk}`,
            `test-bin present=${testBinOk}`,
            `validate-release node-version=${releaseNodeVersions.join(', ') || 'missing'}`,
            `validate-release os=${releaseOsVersions.join(', ') || 'missing'}`,
            `smoke node-version=${smokeNodeVersions.join(', ') || 'missing'}`,
            `smoke os=${smokeOsVersions.join(', ') || 'missing'}`
        ]
    };
}

function validateSecurityCiBaselineContract(repoRoot: string): { passed: boolean; details: string[] } {
    const securityWorkflow = readTextFileIfExists(path.join(repoRoot, '.github', 'workflows', 'security.yml')) || '';
    const secretScanningWorkflow = readTextFileIfExists(path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml')) || '';
    const sbomWorkflow = readTextFileIfExists(path.join(repoRoot, '.github', 'workflows', 'sbom.yml')) || '';
    const branchProtection = readTextFileIfExists(path.join(repoRoot, 'docs', 'branch-protection.md')) || '';

    const npmAuditBlocking = extractWorkflowRunScripts(securityWorkflow)
        .some((script) => scriptHasExecutableCommand(script, 'npm audit --audit-level=high --no-fund'));
    const osvScanJob = getWorkflowJobBlock(securityWorkflow, 'osv-scan');
    const osvScanArgsBlock = getYamlKeyBlock(getYamlKeyBlock(osvScanJob, 'with'), 'scan-args');
    const osvInformational = workflowHasUseStep(
        osvScanJob || '',
        'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0'
    )
        && blockHasNonCommentLine(osvScanArgsBlock, '--lockfile=package-lock.json');
    const gitleaksStep = getWorkflowUseStepBlock(secretScanningWorkflow, 'gitleaks/gitleaks-action@v2');
    const gitleaksBlocking = gitleaksStep !== null
        && blockHasNonCommentLine(getYamlKeyBlock(gitleaksStep, 'env'), 'GITLEAKS_CONFIG: .gitleaks.toml');
    const uploadArtifactStep = getWorkflowUseStepBlock(sbomWorkflow, 'actions/upload-artifact@v4');
    const sbomInformational = extractWorkflowRunScripts(sbomWorkflow)
        .some((script) => scriptHasExecutableCommand(script, 'npx --yes @cyclonedx/cyclonedx-npm'))
        && uploadArtifactStep !== null
        && blockHasNonCommentLine(getYamlKeyBlock(uploadArtifactStep, 'with'), 'if-no-files-found: error');
    const requiredCheckGuidance = [
        'Release Security Required Checks',
        '| `CI` / release validation matrix | `blocking` |',
        '| `Security / npm audit` | `blocking` |',
        '| `Secret Scanning / Gitleaks` | `blocking` |',
        '| `Security / OSV Vulnerability Scan` | `informational` |',
        '| `SBOM / Generate SBOM` | `informational` |'
    ].every((marker) => branchProtection.includes(marker));
    const actionPinningDecision = [
        'GitHub Action pinning decision',
        'version-tag pinned',
        'not SHA-pinned',
        'future provenance or release-signing work'
    ].every((marker) => branchProtection.includes(marker));
    const updateSourcePolicyReporting = [
        'Update-source policy reporting',
        'NPM_REGISTRY_INTEGRITY_RECORDED',
        'TRUSTED_GIT_NO_RELEASE_SIGNATURE',
        'TRUST_OVERRIDE_UNVERIFIED'
    ].every((marker) => branchProtection.includes(marker));

    const checks = [
        { passed: npmAuditBlocking, detail: 'blocking: security.yml npm audit high-severity gate present' },
        { passed: osvInformational, detail: 'informational: security.yml OSV lockfile scan present' },
        { passed: gitleaksBlocking, detail: 'blocking: secret-scanning.yml gitleaks gate present' },
        { passed: sbomInformational, detail: 'informational: sbom.yml CycloneDX artifact generation present' },
        { passed: requiredCheckGuidance, detail: 'informational: branch protection required-check guidance labels retained security checks' },
        { passed: actionPinningDecision, detail: 'informational: GitHub Action pinning decision documented' },
        { passed: updateSourcePolicyReporting, detail: 'informational: update-source policy reporting statuses documented' }
    ];

    return {
        passed: checks.every((check) => check.passed),
        details: checks.map((check) => `${check.detail}=${check.passed}`)
    };
}

function validateReleaseReadinessContracts(repoRoot: string): ReleaseReadinessResult {
    const normalizedRoot = path.resolve(repoRoot);
    const violations: string[] = [];
    const checks: ReleaseReadinessCheck[] = [];
    const packageJson = readPackageJsonObject(normalizedRoot, violations);
    const scripts = getStringRecord(packageJson?.scripts);
    const packageFiles = getStringArray(packageJson?.files);
    const version = typeof packageJson?.version === 'string' ? packageJson.version : null;

    const validateRelease = scripts['validate:release'] || '';
    const validateReadiness = scripts['validate:release-readiness'] || '';
    const releaseSmoke = scripts['test:release-smoke'] || '';
    const releasePreflight = scripts['release:preflight'] || '';
    const archiveSource = scripts['archive:source'] || '';
    const archiveEvidence = scripts['archive:evidence'] || '';
    const quality = scripts.quality || '';
    const qualityFast = scripts['quality:fast'] || '';
    const prepack = scripts.prepack || '';
    const manifestText = readTextFileIfExists(path.join(normalizedRoot, 'MANIFEST.md')) || '';
    const validateReleaseFast = scripts['validate:release:fast'] || '';

    pushCheck(
        checks,
        violations,
        'package',
        'validate:release composes clean worktree, version parity, build, embedded parity, quality, pack smoke, and final clean worktree',
        Boolean(validateRelease) &&
            validateRelease.includes('npm run validate:version-parity') &&
            validateRelease.includes('npm run build') &&
            validateRelease.includes('npm run validate:embedded-bundle-parity') &&
            validateRelease.includes('npm run quality') &&
            validateRelease.includes('npm run test:packaging') &&
            countOccurrences(validateRelease, 'npm run validate:clean-worktree') >= 2,
        [validateRelease || 'missing validate:release']
    );

    pushCheck(
        checks,
        violations,
        'package-fast',
        'validate:release:fast composes clean worktree, version parity, build, embedded parity, fast quality, pack smoke, and final clean worktree',
        Boolean(validateReleaseFast) &&
            validateReleaseFast.includes('npm run validate:version-parity') &&
            validateReleaseFast.includes('npm run build') &&
            validateReleaseFast.includes('npm run validate:embedded-bundle-parity') &&
            validateReleaseFast.includes('npm run quality:fast') &&
            validateReleaseFast.includes('npm run test:packaging') &&
            countOccurrences(validateReleaseFast, 'npm run validate:clean-worktree') >= 2,
        [validateReleaseFast || 'missing validate:release:fast']
    );

    pushCheck(
        checks,
        violations,
        'release-gate',
        'release:preflight runs release readiness and short release smoke before the expensive release validation path',
        validateReadiness === 'node scripts/node-foundation/build-scripts.cjs validate-release.js release-readiness' &&
            releaseSmoke.includes('tests/node/core/task-ids.test.ts') &&
            releaseSmoke.includes('tests/node/gate-runtime/task-events-append.test.ts') &&
            releaseSmoke.includes('tests/node/gates/next-step/next-step-startup-routing.test.ts') &&
            releaseSmoke.includes('tests/node/validators/status.test.ts') &&
            releaseSmoke.includes('tests/node/validators/why-blocked.test.ts') &&
            releaseSmoke.includes('tests/node/validators/doctor-formatting.test.ts') &&
            !releaseSmoke.includes('tests/node/packaging/pack-smoke.test.ts') &&
            validateRelease.includes('npm run test:packaging') &&
            releasePreflight === 'npm run validate:release-readiness && npm run test:release-smoke && npm run validate:release',
        [
            `validate:release-readiness=${validateReadiness || 'missing'}`,
            `test:release-smoke=${releaseSmoke || 'missing'}`,
            `validate:release=${validateRelease || 'missing'}`,
            `release:preflight=${releasePreflight || 'missing'}`
        ]
    );

    pushCheck(
        checks,
        violations,
        'release-archives',
        'release handoff exposes separate source and evidence archive commands',
        archiveSource === 'node scripts/node-foundation/build-scripts.cjs archive-release.js source' &&
            archiveEvidence === 'node scripts/node-foundation/build-scripts.cjs archive-release.js evidence',
        [
            `archive:source=${archiveSource || 'missing'}`,
            `archive:evidence=${archiveEvidence || 'missing'}`
        ]
    );

    pushCheck(
        checks,
        violations,
        'security',
        'quality keeps unused-symbol enforcement, production audit, and security document surface aligned',
        quality.includes('npm run typecheck:unused') &&
            qualityFast.includes('npm run typecheck:unused') &&
            scripts['typecheck:unused'] === 'tsc -p tsconfig.node-foundation.json --noEmit --pretty false --noUnusedLocals --noUnusedParameters' &&
            quality.includes('npm run audit:prod') &&
            scripts['audit:prod'] === 'npm audit --omit=dev' &&
            SECURITY_RELEASE_DOC_ITEMS.every((entry) => fileExists(normalizedRoot, entry)) &&
            SECURITY_RELEASE_DOC_ITEMS.every((entry) => packageFiles.includes(entry)) &&
            manifestListsEvery(manifestText, SECURITY_RELEASE_DOC_ITEMS),
        [
            quality || 'missing quality',
            `quality:fast=${qualityFast || 'missing'}`,
            `typecheck:unused=${scripts['typecheck:unused'] || 'missing'}`,
            `audit:prod=${scripts['audit:prod'] || 'missing'}`,
            `security_docs=${SECURITY_RELEASE_DOC_ITEMS.join(', ')}`
        ]
    );

    pushCheck(
        checks,
        violations,
        'packaging',
        'prepack and package files preserve clean-package, sourceful runtime, and linked public-doc contracts',
        prepack.includes('npm run validate:clean-worktree') &&
            prepack.includes('npm run build:publish-runtime') &&
            prepack.includes('node scripts/package-legacy-entrypoint-compat.cjs create') &&
            SOURCEFUL_PACKAGE_SURFACE_ITEMS
                .concat(SECURITY_RELEASE_DOC_ITEMS)
                .concat(PUBLIC_PACKAGE_DOC_ITEMS)
                .every((entry) => packageFiles.includes(entry)) &&
            PUBLIC_PACKAGE_DOC_ITEMS.every((entry) => fileExists(normalizedRoot, entry)) &&
            manifestListsEvery(manifestText, PUBLIC_PACKAGE_DOC_ITEMS) &&
            !packageFiles.includes('.node-build'),
        [prepack || 'missing prepack', `files=${packageFiles.join(', ') || 'missing'}`]
    );

    const requiredTestShardScripts = Object.freeze([
        'test:unit',
        'test:gates',
        'test:cli',
        'test:lifecycle',
        'test:bin',
        'test:packaging',
        'test:sharded',
        'test:full'
    ]);
    const missingShardScripts = requiredTestShardScripts.filter((name) => !scripts[name]);
    pushCheck(
        checks,
        violations,
        'test-shards',
        'focused test shard scripts are present in package.json for targeted validation',
        missingShardScripts.length === 0,
        missingShardScripts.length === 0
            ? requiredTestShardScripts.map((name) => `${name}: present`)
            : missingShardScripts.map((name) => `missing: ${name}`)
    );

    const ciWorkflow = readTextFileIfExists(path.join(normalizedRoot, '.github', 'workflows', 'ci.yml')) || '';
    const ciRuntimeMatrix = validateCiRuntimeMatrixContract(ciWorkflow);
    pushCheck(
        checks,
        violations,
        'ci',
        'CI keeps release validation on Linux and Windows, Node 22.13+ and Node 24 matrices, and lifecycle update smoke on all supported OS families',
        ciRuntimeMatrix.passed,
        ciRuntimeMatrix.details
    );

    const securityCiBaseline = validateSecurityCiBaselineContract(normalizedRoot);
    pushCheck(
        checks,
        violations,
        'security-ci',
        'existing release-security CI checks are present and labelled blocking or informational',
        securityCiBaseline.passed,
        securityCiBaseline.details
    );

    const cliReference = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'cli-reference.md')) || '';
    const runMethods = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'run-methods.md')) || '';
    const platformDocs = readTextFileIfExists(path.join(normalizedRoot, 'docs', 'node-platform-foundation.md')) || '';
    pushCheck(
        checks,
        violations,
        'runtime-state',
        'operator docs keep doctor, manifest validation, task-event timelines, derived-index recovery, and full-suite optimization guardrails visible',
        cliReference.includes('garda doctor') &&
            cliReference.includes('garda gate validate-manifest') &&
            cliReference.includes('runtime/task-events/<task-id>.jsonl') &&
            runMethods.includes('gate validate-manifest') &&
            platformDocs.includes('cross-platform lifecycle smoke') &&
            platformDocs.includes('Full-suite optimization compatibility guardrails') &&
            platformDocs.includes('GARDA_NODE_FOUNDATION_TEST_SHARDS'),
        ['docs/cli-reference.md, docs/run-methods.md, docs/node-platform-foundation.md']
    );

    const releaseChecklist = validateReleaseChecklist(normalizedRoot, version);
    pushCheck(
        checks,
        violations,
        'release-blockers',
        'tracked Release 1.1.0 readiness checklist is complete',
        releaseChecklist.releaseChecklistItems.length > 0 &&
            releaseChecklist.openReleaseChecklistItems.length === 0,
        releaseChecklist.details
    );

    const releaseNotesInput = [
        `Version: ${version || 'unknown'}`,
        'Validation command: npm run release:preflight',
        'Package proof: validate:release covers clean worktree, version parity, build, embedded bundle parity, quality, pack smoke, and final clean worktree.',
        'Readiness alignment: validate:release-readiness checks package, CI runtime matrix, runtime-state docs, security-document surface, and the tracked Release 1.1.0 checklist before the full proof path.',
        'Short smoke: test:release-smoke exercises task id parsing, task-event append integrity, next-step startup routing, and status and doctor formatting before the full proof path.',
        'Package smoke: npm run test:packaging remains an explicit validate:release step for pack, install, and CLI invoke proof.',
        'Update/runtime alignment: CI workflow is configured for setup, update git, doctor, and uninstall smoke across Linux, Windows, and macOS.',
        'Unused-symbol enforcement: quality includes typecheck:unused with --noUnusedLocals and --noUnusedParameters before lint, coverage, and production npm audit.',
        'Security/audit alignment: quality includes production npm audit and security/SBOM/threat-model docs are present in source, package files, and MANIFEST.',
        'Release-security baseline: readiness labels npm audit and gitleaks as blocking, OSV and SBOM as informational, and reports action-pinning plus update-source provenance policy without adding a duplicate security pipeline.'
    ];

    return {
        repoRoot: normalizedRoot,
        version,
        passed: violations.length === 0,
        violations,
        checks,
        releaseChecklistItems: releaseChecklist.releaseChecklistItems,
        openReleaseChecklistItems: releaseChecklist.openReleaseChecklistItems,
        releaseNotesInput
    };
}

export function validateReleaseReadiness(repoRoot: string): ReleaseReadinessResult {
    return validateReleaseReadinessContracts(repoRoot);
}

export function formatReleaseReadinessResult(result: ReleaseReadinessResult): string {
    const lines: string[] = [];

    lines.push(result.passed ? 'RELEASE_READINESS_OK' : 'RELEASE_READINESS_FAILED');
    lines.push(`RepoRoot: ${result.repoRoot}`);
    lines.push(`Version: ${result.version || 'unknown'}`);
    lines.push(`ReleaseChecklistItems: ${result.releaseChecklistItems.length}`);
    lines.push(`OpenReleaseChecklistItems: ${result.openReleaseChecklistItems.length === 0 ? 'none' : result.openReleaseChecklistItems.join('; ')}`);
    lines.push('Checklist:');
    for (const check of result.checks) {
        lines.push(`  [${check.passed ? 'x' : ' '}] ${check.area}: ${check.label}`);
        if (!check.passed) {
            for (const detail of check.details) {
                lines.push(`      - ${detail}`);
            }
        }
    }

    if (!result.passed) {
        lines.push('Violations:');
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
    }

    lines.push('ReleaseNotesInput:');
    for (const entry of result.releaseNotesInput) {
        lines.push(`- ${entry}`);
    }

    return lines.join('\n');
}

export function runReleaseReadinessValidation(): ReleaseReadinessResult {
    const result = validateReleaseReadiness(getRepoRoot());
    console.log(formatReleaseReadinessResult(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}
