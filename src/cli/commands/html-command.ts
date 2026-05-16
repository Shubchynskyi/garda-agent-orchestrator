import { buildStaticHtmlReport, type StaticHtmlReportResult } from '../../reports/static-html-report';
import {
    buildCommandHelpText,
    normalizePathValue,
    parseOptions,
    type PackageJsonLike
} from './cli-helpers';
import type { ParsedOptionsRecord } from './shared-command-utils';

const HTML_COMMAND_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--repo-root': { key: 'targetRoot', type: 'string' },
    '--output-path': { key: 'outputPath', type: 'string' },
    '--snapshot': { key: 'snapshot', type: 'boolean' },
    '--retain-snapshots': { key: 'retainSnapshots', type: 'string' },
    '--json': { key: 'json', type: 'boolean' }
};

function shouldPrintHtmlHelp(commandArgv: string[]): boolean {
    return commandArgv[0] === 'help'
        || commandArgv.some((argument) => argument === '--help' || argument === '-h');
}

function formatHtmlReportOutput(result: StaticHtmlReportResult, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify(result, null, 2);
    }
    return [
        'GARDA_HTML_REPORT',
        `LatestPath: ${result.latest_path}`,
        `LatestUrl: ${result.latest_url}`,
        `OutputPath: ${result.output_path}`,
        `Url: ${result.url}`,
        `SnapshotPath: ${result.snapshot_path || 'none'}`,
        `SnapshotUrl: ${result.snapshot_url || 'none'}`,
        `SnapshotRetention: ${result.snapshot_retention ?? 'none'}`,
        `DeletedSnapshots: ${result.deleted_snapshot_paths.length}`,
        `Tasks: ${result.task_count}`,
        `WorkflowSettings: ${result.workflow_setting_count}`,
        `Unavailable: ${result.unavailable_count}`
    ].join('\n');
}

function parseSnapshotRetention(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--retain-snapshots must be a positive integer.');
    }
    return parsed;
}

export function handleHtml(commandArgv: string[], _packageJson: PackageJsonLike): StaticHtmlReportResult | null {
    if (shouldPrintHtmlHelp(commandArgv)) {
        console.log(buildCommandHelpText('html'));
        return null;
    }

    const { options } = parseOptions(commandArgv, HTML_COMMAND_DEFINITIONS);
    const parsed = options as ParsedOptionsRecord;
    const targetRoot = typeof parsed.targetRoot === 'string'
        ? normalizePathValue(parsed.targetRoot)
        : normalizePathValue('.');
    const outputPath = typeof parsed.outputPath === 'string' && parsed.outputPath.trim()
        ? normalizePathValue(parsed.outputPath)
        : null;
    const snapshotRetention = parseSnapshotRetention(parsed.retainSnapshots);
    const result = buildStaticHtmlReport({
        repoRoot: targetRoot,
        outputPath,
        snapshot: parsed.snapshot === true || snapshotRetention !== null,
        snapshotRetention
    });
    console.log(formatHtmlReportOutput(result, parsed.json === true));
    return result;
}
