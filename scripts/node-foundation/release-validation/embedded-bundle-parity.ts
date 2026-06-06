import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../build';
import {
    EMBEDDED_BUNDLE_PARITY_ITEMS,
    type EmbeddedBundleParityItemResult,
    type EmbeddedBundleParityResult
} from './types';
import { hashSurfaceItem, isGitIgnored } from './shared';

export function validateEmbeddedBundleParity(
    repoRoot: string,
    items: readonly string[] = EMBEDDED_BUNDLE_PARITY_ITEMS
): EmbeddedBundleParityResult {
    const normalizedRoot = path.resolve(repoRoot);
    const bundleRoot = path.join(normalizedRoot, 'garda-agent-orchestrator');
    const bundlePresent = fs.existsSync(bundleRoot);
    const bundleIgnoredByGit = bundlePresent && isGitIgnored(normalizedRoot, 'garda-agent-orchestrator');
    const violations: string[] = [];
    const itemResults: EmbeddedBundleParityItemResult[] = [];
    const checkedItems = [...items];

    if (!bundlePresent || bundleIgnoredByGit) {
        return {
            repoRoot: normalizedRoot,
            bundleRoot,
            bundlePresent,
            bundleIgnoredByGit,
            checkedItems,
            passed: true,
            violations,
            items: itemResults
        };
    }

    for (const item of checkedItems) {
        const rootItemPath = path.join(normalizedRoot, item);
        const bundleItemPath = path.join(bundleRoot, item);
        const rootExists = fs.existsSync(rootItemPath);
        const bundleExists = fs.existsSync(bundleItemPath);
        const rootHash = rootExists ? hashSurfaceItem(rootItemPath) : null;
        const bundleHash = bundleExists ? hashSurfaceItem(bundleItemPath) : null;

        itemResults.push({
            item,
            rootExists,
            bundleExists,
            rootHash,
            bundleHash
        });

        if (!rootExists || !bundleExists) {
            violations.push(`${item}: missing root=${rootExists} bundle=${bundleExists}`);
            continue;
        }
        if (rootHash !== bundleHash) {
            violations.push(`${item}: hash mismatch`);
        }
    }

    return {
        repoRoot: normalizedRoot,
        bundleRoot,
        bundlePresent,
        bundleIgnoredByGit,
        checkedItems,
        passed: violations.length === 0,
        violations,
        items: itemResults
    };
}

export function formatEmbeddedBundleParityResult(result: EmbeddedBundleParityResult): string {
    const lines: string[] = [];
    const checkedItemCount = result.bundlePresent && !result.bundleIgnoredByGit ? result.checkedItems.length : 0;

    if (!result.passed) {
        lines.push('RELEASE_EMBEDDED_BUNDLE_PARITY_FAILED');
        lines.push(`RepoRoot: ${result.repoRoot}`);
        lines.push(`BundleRoot: ${result.bundleRoot}`);
        lines.push(`CheckedItems: ${result.checkedItems.length}`);
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
        lines.push('Remediation: refresh the generated embedded bundle from the root source before release.');
        return lines.join('\n');
    }

    lines.push(`RepoRoot: ${result.repoRoot}`);
    lines.push(`BundleRoot: ${result.bundleRoot}`);
    if (result.bundleIgnoredByGit) {
        lines.push('BundlePresent: yes (gitignored generated artifact omitted from release surface)');
    } else {
        lines.push(`BundlePresent: ${result.bundlePresent ? 'yes' : 'no (generated artifact omitted)'}`);
    }
    if (checkedItemCount === 0) {
        lines.unshift('RELEASE_EMBEDDED_BUNDLE_PARITY_SKIPPED');
        lines.push('ParityStatus: SKIPPED (no embedded bundle parity items checked)');
    } else {
        lines.unshift('RELEASE_EMBEDDED_BUNDLE_PARITY_OK');
    }
    lines.push(`CheckedItems: ${checkedItemCount}`);
    return lines.join('\n');
}

export function runEmbeddedBundleParityValidation(): EmbeddedBundleParityResult {
    const result = validateEmbeddedBundleParity(getRepoRoot());
    console.log(formatEmbeddedBundleParityResult(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}
