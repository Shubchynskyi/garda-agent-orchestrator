import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../core/constants';

export interface LargeModuleTaskReference {
    task_id: string;
    status: string;
    title: string;
}

export interface LargeModuleFileEntry {
    relative_path: string;
    category: 'source' | 'test' | 'script';
    line_count: number;
    byte_count: number;
    owner_tasks: LargeModuleTaskReference[];
    todo_follow_up_exists: boolean;
}

export interface LargeModuleDeclarationEntry {
    relative_path: string;
    declaration_kind: string;
    declaration_name: string;
    start_line: number;
    end_line: number;
    line_count: number;
    owner_tasks: LargeModuleTaskReference[];
    todo_follow_up_exists: boolean;
}

export interface LargeModuleReportSummary {
    scanned_file_count: number;
    total_lines: number;
    largest_source_lines: number;
    largest_test_lines: number;
    files_with_todo_follow_up: number;
}

export interface NextStepModuleBudgetEntry {
    relative_path: string;
    role: 'coordinator' | 'helper';
    responsibility: string;
    line_count: number;
    line_budget: number;
    budget_status: 'WITHIN_BUDGET' | 'OVER_BUDGET';
    owner_tasks: LargeModuleTaskReference[];
    todo_follow_up_exists: boolean;
    exception_reason: string | null;
}

export interface NextStepModuleBudgetReport {
    schema_version: 1;
    mode: 'REPORT_ONLY';
    coordinator_line_budget: number;
    helper_line_budget: number;
    status: 'WITHIN_BUDGET' | 'OVER_BUDGET';
    total_module_count: number;
    total_lines: number;
    largest_helper_lines: number;
    over_budget_count: number;
    modules: NextStepModuleBudgetEntry[];
}

export interface LargeModuleReport {
    schema_version: 1;
    mode: 'REPORT_ONLY';
    target_root: string;
    scanned_roots: string[];
    ignored_roots: string[];
    file_extensions: string[];
    generated_file_policy: string;
    summary: LargeModuleReportSummary;
    top_source_files: LargeModuleFileEntry[];
    top_test_files: LargeModuleFileEntry[];
    top_declarations: LargeModuleDeclarationEntry[];
    next_step_module_budget: NextStepModuleBudgetReport;
}

interface LargeModuleReportOptions {
    fileLimit?: number;
    declarationLimit?: number;
}

interface TaskQueueEntry {
    task_id: string;
    status: string;
    title: string;
    row_text: string;
}

interface FileScanEntry {
    absolutePath: string;
    relativePath: string;
    category: 'source' | 'test' | 'script';
    content: string;
    lineCount: number;
    byteCount: number;
}

const DEFAULT_FILE_LIMIT = 10;
const DEFAULT_DECLARATION_LIMIT = 10;
const NEXT_STEP_COORDINATOR_LINE_BUDGET = 5000;
const NEXT_STEP_HELPER_LINE_BUDGET = 1000;
const SCAN_ROOTS = ['src', 'tests', 'scripts', 'bin'];
const IGNORED_ROOTS = [
    '.git',
    'coverage',
    'dist',
    'node_modules',
    DEFAULT_BUNDLE_NAME
];
const FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

function normalizeRelativePath(pathValue: string): string {
    return pathValue.replace(/\\/g, '/');
}

function countLines(content: string): number {
    if (content.length === 0) return 0;
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const split = normalized.split('\n');
    return split[split.length - 1] === '' ? split.length - 1 : split.length;
}

function shouldScanFile(filePath: string): boolean {
    const extension = path.extname(filePath);
    if (!FILE_EXTENSIONS.includes(extension)) return false;
    return !filePath.endsWith('.d.ts');
}

function categorizePath(relativePath: string): 'source' | 'test' | 'script' {
    if (relativePath.startsWith('tests/')) return 'test';
    if (relativePath.startsWith('scripts/') || relativePath.startsWith('bin/')) return 'script';
    return 'source';
}

function collectFilesFromRoot(rootPath: string, targetRoot: string, output: FileScanEntry[]): void {
    if (!fs.existsSync(rootPath)) return;
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        const absolutePath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            if (IGNORED_ROOTS.includes(entry.name)) continue;
            collectFilesFromRoot(absolutePath, targetRoot, output);
            continue;
        }
        if (!entry.isFile() || !shouldScanFile(absolutePath)) continue;
        const content = fs.readFileSync(absolutePath, 'utf8');
        const relativePath = normalizeRelativePath(path.relative(targetRoot, absolutePath));
        output.push({
            absolutePath,
            relativePath,
            category: categorizePath(relativePath),
            content,
            lineCount: countLines(content),
            byteCount: Buffer.byteLength(content, 'utf8')
        });
    }
}

function collectScannedFiles(targetRoot: string): FileScanEntry[] {
    const files: FileScanEntry[] = [];
    for (const rootName of SCAN_ROOTS) {
        collectFilesFromRoot(path.join(targetRoot, rootName), targetRoot, files);
    }
    return files;
}

function parseTaskQueue(targetRoot: string): TaskQueueEntry[] {
    const taskPath = path.join(targetRoot, 'TASK.md');
    if (!fs.existsSync(taskPath)) return [];
    const content = fs.readFileSync(taskPath, 'utf8');
    const tasks: TaskQueueEntry[] = [];
    for (const line of content.split(/\r?\n/)) {
        const columns = line.split('|').map((value) => value.trim());
        if (columns.length < 6) continue;
        const taskId = columns[1] || '';
        if (!/^T-\d/.test(taskId)) continue;
        tasks.push({
            task_id: taskId,
            status: columns[2] || '',
            title: columns[5] || '',
            row_text: line.toLowerCase()
        });
    }
    return tasks;
}

function buildTaskSearchTerms(relativePath: string): string[] {
    const normalized = relativePath.toLowerCase();
    const basename = path.basename(relativePath).toLowerCase();
    const extension = path.extname(basename);
    const stem = extension ? basename.slice(0, -extension.length) : basename;
    const terms = [normalized, basename, stem].filter((value) => value.length > 0);
    return Array.from(new Set(terms));
}

function isOpenFollowUp(status: string): boolean {
    return /TODO|IN_PROGRESS|IN REVIEW|IN_REVIEW|SPLIT_REQUIRED/i.test(status);
}

function resolveOwnerTasks(relativePath: string, taskQueue: readonly TaskQueueEntry[]): LargeModuleTaskReference[] {
    const terms = buildTaskSearchTerms(relativePath);
    const matches: LargeModuleTaskReference[] = [];
    for (const task of taskQueue) {
        if (!terms.some((term) => task.row_text.includes(term))) continue;
        matches.push({
            task_id: task.task_id,
            status: task.status,
            title: task.title
        });
    }
    return matches.slice(0, 8);
}

function toFileEntry(file: FileScanEntry, taskQueue: readonly TaskQueueEntry[]): LargeModuleFileEntry {
    const ownerTasks = resolveOwnerTasks(file.relativePath, taskQueue);
    return {
        relative_path: file.relativePath,
        category: file.category,
        line_count: file.lineCount,
        byte_count: file.byteCount,
        owner_tasks: ownerTasks,
        todo_follow_up_exists: ownerTasks.some((task) => isOpenFollowUp(task.status))
    };
}

function parseDeclarationKind(line: string): { kind: string; name: string } | null {
    const normalized = line.trim();
    const declarationMatch = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(normalized);
    if (declarationMatch) {
        return { kind: declarationMatch[1], name: declarationMatch[2] };
    }
    const variableMatch = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(normalized);
    if (variableMatch) {
        return { kind: 'const', name: variableMatch[1] };
    }
    return null;
}

function collectDeclarations(file: FileScanEntry, taskQueue: readonly TaskQueueEntry[]): LargeModuleDeclarationEntry[] {
    const lines = file.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const declarationStarts: Array<{ lineIndex: number; kind: string; name: string }> = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const leadingWhitespace = line.length - line.trimStart().length;
        if (leadingWhitespace > 4) continue;
        const declaration = parseDeclarationKind(line);
        if (!declaration) continue;
        declarationStarts.push({
            lineIndex: index,
            kind: declaration.kind,
            name: declaration.name
        });
    }
    return declarationStarts.map((declaration, index) => {
        const nextStart = declarationStarts[index + 1]?.lineIndex ?? lines.length;
        const endLine = Math.max(declaration.lineIndex + 1, nextStart);
        const ownerTasks = resolveOwnerTasks(file.relativePath, taskQueue);
        return {
            relative_path: file.relativePath,
            declaration_kind: declaration.kind,
            declaration_name: declaration.name,
            start_line: declaration.lineIndex + 1,
            end_line: endLine,
            line_count: endLine - declaration.lineIndex,
            owner_tasks: ownerTasks,
            todo_follow_up_exists: ownerTasks.some((task) => isOpenFollowUp(task.status))
        };
    });
}

function sortByLinesDesc<T extends { line_count: number; relative_path: string }>(entries: T[]): T[] {
    return entries.sort((left, right) => {
        if (right.line_count !== left.line_count) return right.line_count - left.line_count;
        return left.relative_path.localeCompare(right.relative_path);
    });
}

function isNextStepModule(relativePath: string): boolean {
    return /^src\/gates\/next-step(?:[-\w]+)?\.ts$/u.test(relativePath);
}

function describeNextStepResponsibility(relativePath: string): string {
    const explicitResponsibilities: Record<string, string> = {
        'src/gates/next-step.ts': 'public navigator coordinator and result assembly',
        'src/gates/next-step-compile-full-suite-readiness.ts': 'compile, preflight, and full-suite readiness reads',
        'src/gates/next-step-task-queue.ts': 'task queue parsing and child routing reads',
        'src/gates/next-step-task-queue-transitions.ts': 'gate-owned task queue status transitions',
        'src/gates/next-step-review-artifact-readers.ts': 'review artifact, receipt, scoped-diff, and trust reads',
        'src/gates/next-step-review-cycle-guard.ts': 'review-cycle attempt guard and split/continuation prompts',
        'src/gates/next-step-reviewer-launch-evidence.ts': 'delegated reviewer launch and invocation evidence reads',
        'src/gates/next-step-split-required-latch.ts': 'split-required latch evidence and materialization',
        'src/gates/next-step-closeout-status-readers.ts': 'final closeout status, final report, and post-DONE drift reads',
        'src/gates/next-step-closeout-routing.ts': 'post-review and completed-closeout route selection',
        'src/gates/next-step-terminal-status-routing.ts': 'terminal task queue status route selection'
    };
    if (explicitResponsibilities[relativePath]) {
        return explicitResponsibilities[relativePath];
    }
    const stem = path.basename(relativePath, '.ts').replace(/^next-step-/, '').replace(/-/g, ' ');
    return `next-step helper: ${stem || 'shared helper'}`;
}

function buildNextStepModuleBudget(
    fileEntries: readonly LargeModuleFileEntry[]
): NextStepModuleBudgetReport {
    const modules = sortByLinesDesc(
        fileEntries
            .filter((entry) => isNextStepModule(entry.relative_path))
            .map((entry): NextStepModuleBudgetEntry => {
                const role = entry.relative_path === 'src/gates/next-step.ts' ? 'coordinator' : 'helper';
                const lineBudget = role === 'coordinator'
                    ? NEXT_STEP_COORDINATOR_LINE_BUDGET
                    : NEXT_STEP_HELPER_LINE_BUDGET;
                const overBudget = entry.line_count > lineBudget;
                return {
                    relative_path: entry.relative_path,
                    role,
                    responsibility: describeNextStepResponsibility(entry.relative_path),
                    line_count: entry.line_count,
                    line_budget: lineBudget,
                    budget_status: overBudget ? 'OVER_BUDGET' : 'WITHIN_BUDGET',
                    owner_tasks: entry.owner_tasks,
                    todo_follow_up_exists: entry.todo_follow_up_exists,
                    exception_reason: overBudget
                        ? 'Report-only budget exception: keep a concrete decomposition follow-up before raising this threshold.'
                        : null
                };
            })
    );
    const overBudgetCount = modules.filter((entry) => entry.budget_status === 'OVER_BUDGET').length;
    return {
        schema_version: 1,
        mode: 'REPORT_ONLY',
        coordinator_line_budget: NEXT_STEP_COORDINATOR_LINE_BUDGET,
        helper_line_budget: NEXT_STEP_HELPER_LINE_BUDGET,
        status: overBudgetCount > 0 ? 'OVER_BUDGET' : 'WITHIN_BUDGET',
        total_module_count: modules.length,
        total_lines: modules.reduce((total, entry) => total + entry.line_count, 0),
        largest_helper_lines: modules
            .filter((entry) => entry.role === 'helper')
            .reduce((largest, entry) => Math.max(largest, entry.line_count), 0),
        over_budget_count: overBudgetCount,
        modules
    };
}

export function collectLargeModuleReport(
    targetRootInput: string,
    options?: LargeModuleReportOptions
): LargeModuleReport {
    const targetRoot = path.resolve(targetRootInput);
    const fileLimit = options?.fileLimit ?? DEFAULT_FILE_LIMIT;
    const declarationLimit = options?.declarationLimit ?? DEFAULT_DECLARATION_LIMIT;
    const files = collectScannedFiles(targetRoot);
    const taskQueue = parseTaskQueue(targetRoot);
    const fileEntries = files.map((file) => toFileEntry(file, taskQueue));
    const sourceFileEntries = sortByLinesDesc(fileEntries.filter((entry) => entry.category !== 'test'));
    const testFileEntries = sortByLinesDesc(fileEntries.filter((entry) => entry.category === 'test'));
    const declarationEntries = sortByLinesDesc(files.flatMap((file) => collectDeclarations(file, taskQueue)));
    const scannedRootPaths = SCAN_ROOTS
        .map((rootName) => path.join(targetRoot, rootName))
        .filter((rootPath) => fs.existsSync(rootPath))
        .map((rootPath) => normalizeRelativePath(path.relative(targetRoot, rootPath) || '.'));

    return {
        schema_version: 1,
        mode: 'REPORT_ONLY',
        target_root: normalizeRelativePath(targetRoot),
        scanned_roots: scannedRootPaths,
        ignored_roots: IGNORED_ROOTS,
        file_extensions: FILE_EXTENSIONS,
        generated_file_policy: 'Scans repo-local src, tests, scripts, and bin roots; skips dist, coverage, node_modules, .git, deployed bundle, and .d.ts files.',
        summary: {
            scanned_file_count: fileEntries.length,
            total_lines: fileEntries.reduce((total, entry) => total + entry.line_count, 0),
            largest_source_lines: sourceFileEntries[0]?.line_count ?? 0,
            largest_test_lines: testFileEntries[0]?.line_count ?? 0,
            files_with_todo_follow_up: fileEntries.filter((entry) => entry.todo_follow_up_exists).length
        },
        top_source_files: sourceFileEntries.slice(0, fileLimit),
        top_test_files: testFileEntries.slice(0, fileLimit),
        top_declarations: declarationEntries.slice(0, declarationLimit),
        next_step_module_budget: buildNextStepModuleBudget(fileEntries)
    };
}
