import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBundleName } from '../core/constants';
import {
    buildReportDataContract,
    DEFAULT_REPORT_MAX_DETAILED_TASKS,
    type ReportDataContract
} from './report-data-contract';
import { renderStaticHtmlDocument } from './static-html/document';

export interface BuildStaticHtmlReportOptions {
    repoRoot: string;
    outputPath?: string | null;
    generatedAtUtc?: string;
    snapshot?: boolean;
    snapshotRetention?: number | null;
    maxDetailedTasks?: number | null;
}

export interface StaticHtmlReportResult {
    output_path: string;
    url: string;
    latest_path: string;
    latest_url: string;
    snapshot_path: string | null;
    snapshot_url: string | null;
    snapshot_retention: number | null;
    deleted_snapshot_paths: string[];
    task_count: number;
    detailed_task_count: number;
    skipped_detail_count: number;
    max_detailed_tasks: number;
    workflow_setting_count: number;
    unavailable_count: number;
}

function resolveDefaultOutputPath(repoRoot: string): string {
    return path.join(path.resolve(repoRoot), resolveBundleName(), 'runtime', 'reports', 'garda-report.html');
}

function resolveSnapshotPath(outputPath: string, generatedAtUtc: string): string {
    const snapshotStamp = generatedAtUtc.replace(/[^0-9A-Za-z]/g, '');
    return path.join(path.dirname(outputPath), 'snapshots', `garda-report-${snapshotStamp}.html`);
}

function pruneSnapshots(snapshotPath: string, retention: number | null | undefined): string[] {
    if (typeof retention !== 'number' || !Number.isInteger(retention) || retention < 1) {
        return [];
    }
    const snapshotDir = path.dirname(snapshotPath);
    if (!fs.existsSync(snapshotDir)) {
        return [];
    }
    const snapshotFiles = fs.readdirSync(snapshotDir)
        .filter((fileName) => /^garda-report-[0-9A-Za-z]+\.html$/.test(fileName))
        .sort()
        .map((fileName) => path.join(snapshotDir, fileName));
    const deleteCount = Math.max(0, snapshotFiles.length - retention);
    const deletedPaths = snapshotFiles.slice(0, deleteCount);
    for (const filePath of deletedPaths) {
        fs.rmSync(filePath, { force: true });
    }
    return deletedPaths;
}

export function renderStaticHtmlReport(report: ReportDataContract, outputPath?: string | null): string {
    const resolvedOutputPath = path.resolve(outputPath || resolveDefaultOutputPath(report.repo_root));
    return renderStaticHtmlDocument(report, {
        repoRoot: report.repo_root,
        outputPath: resolvedOutputPath
    });
}

function resolveMaxDetailedTasks(value: number | null | undefined): number {
    return value === null || value === undefined ? DEFAULT_REPORT_MAX_DETAILED_TASKS : value;
}

export function buildStaticHtmlReport(options: BuildStaticHtmlReportOptions): StaticHtmlReportResult {
    const repoRoot = path.resolve(options.repoRoot);
    const generatedAtUtc = options.generatedAtUtc;
    const maxDetailedTasks = resolveMaxDetailedTasks(options.maxDetailedTasks);
    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc,
        maxDetailedTasks
    });
    const outputPath = path.resolve(options.outputPath || resolveDefaultOutputPath(repoRoot));
    const html = renderStaticHtmlReport(report, outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');
    const snapshotPath = options.snapshot === true
        ? resolveSnapshotPath(outputPath, report.generated_at_utc)
        : null;
    if (snapshotPath) {
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        fs.writeFileSync(snapshotPath, html, 'utf8');
    }
    const deletedSnapshotPaths = snapshotPath
        ? pruneSnapshots(snapshotPath, options.snapshotRetention)
        : [];
    return {
        output_path: outputPath,
        url: pathToFileURL(outputPath).href,
        latest_path: outputPath,
        latest_url: pathToFileURL(outputPath).href,
        snapshot_path: snapshotPath,
        snapshot_url: snapshotPath ? pathToFileURL(snapshotPath).href : null,
        snapshot_retention: typeof options.snapshotRetention === 'number' ? options.snapshotRetention : null,
        deleted_snapshot_paths: deletedSnapshotPaths,
        task_count: report.tasks_tab.rows.length,
        detailed_task_count: report.tasks_tab.rows.filter((row) => row.detail.detail_status === 'loaded').length,
        skipped_detail_count: report.tasks_tab.rows.filter((row) => row.detail.detail_status === 'skipped').length,
        max_detailed_tasks: maxDetailedTasks,
        workflow_setting_count: report.workflow_config_tab.settings.length,
        unavailable_count: report.unavailable.length
    };
}
