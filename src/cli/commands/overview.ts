import { getStatusSnapshot, formatStatusSnapshot } from '../../validators/status';
import {
    applyStatusFormatting,
    buildBannerText,
    buildCommandSummaryLines,
    normalizePathValue,
    PackageJsonLike,
    resolveWorkspaceDisplayVersion
} from './cli-helpers';

function resolveOverviewTargetRoot(targetRoot?: string): string {
    return targetRoot === undefined ? normalizePathValue('.') : targetRoot;
}

export function buildOverviewOutput(packageJson: PackageJsonLike, targetRoot?: string): string {
    const resolvedTargetRoot = resolveOverviewTargetRoot(targetRoot);
    const snapshot = getStatusSnapshot(resolvedTargetRoot);
    const lines: string[] = [];

    lines.push('GARDA_OVERVIEW');
    lines.push(
        buildBannerText(packageJson, 'Workspace overview', resolvedTargetRoot, {
            versionOverride: resolveWorkspaceDisplayVersion(resolvedTargetRoot, packageJson.version)
        })
    );
    lines.push(formatStatusSnapshot(snapshot, { heading: 'GARDA_STATUS' }));
    lines.push('');
    lines.push(...buildCommandSummaryLines());

    return lines.join('\n');
}

export function printOverview(packageJson: PackageJsonLike, targetRoot?: string): void {
    const output = buildOverviewOutput(packageJson, targetRoot);
    console.log(applyStatusFormatting(output));
}

export function handleOverview(packageJson: PackageJsonLike, targetRoot?: string): void {
    printOverview(packageJson, targetRoot);
}
