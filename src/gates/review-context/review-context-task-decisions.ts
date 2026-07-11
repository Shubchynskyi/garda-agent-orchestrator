import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringSha256 } from '../../gate-runtime/hash';
import { normalizePath } from '../shared/helpers';

const MAX_TASK_DECISION_RECORDS = 8;
const MAX_TASK_DECISION_TEXT_CHARS = 2_000;
const OPERATOR_DECISIONS_SECTION_HEADING = '## Operator Decisions';
const DECISION_LINE_PATTERN = /^\s*-\s*(T-[A-Za-z0-9-]+)\s+operator decision\s+\((\d{4}-\d{2}-\d{2})\):\s*(\S(?:.*\S)?)\s*$/u;
const DECISION_CANDIDATE_PATTERN = /^\s*-\s*(T-[A-Za-z0-9-]+)\s+operator decision\b/u;

export interface ReviewContextOperatorDecisionRecord {
    task_id: string;
    date: string;
    text: string;
    source_line: number;
    record_sha256: string;
}

export interface ReviewContextOperatorDecisions {
    status: 'available' | 'none' | 'missing' | 'invalid';
    source_path: string;
    source_sha256: string | null;
    source_section_sha256: string | null;
    ordering: 'source_line_ascending';
    current: ReviewContextOperatorDecisionRecord | null;
    records: ReviewContextOperatorDecisionRecord[];
    warnings: string[];
    violations: string[];
}

function buildUnavailableDecisions(
    taskPath: string,
    status: 'none' | 'missing',
    sourceSha256: string | null,
    violation?: string
): ReviewContextOperatorDecisions {
    return {
        status,
        source_path: normalizePath(taskPath),
        source_sha256: sourceSha256,
        source_section_sha256: null,
        ordering: 'source_line_ascending',
        current: null,
        records: [],
        warnings: [],
        violations: violation ? [violation] : []
    };
}

function isValidIsoDate(value: string): boolean {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function readTaskOperatorDecisions(repoRoot: string, taskId: string | null): ReviewContextOperatorDecisions {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!taskId || !fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return buildUnavailableDecisions(
            taskPath,
            'missing',
            null,
            'TASK.md operator-decision source is missing; task-scoped decisions cannot be verified.'
        );
    }

    const sourceText = fs.readFileSync(taskPath, 'utf8');
    const sourceSha256 = stringSha256(sourceText) || null;
    const sourceLines = sourceText.split(/\r?\n/u);
    const sectionHeadingIndexes = sourceLines
        .map((line, index) => line.trim() === OPERATOR_DECISIONS_SECTION_HEADING ? index : -1)
        .filter((index) => index >= 0);
    if (sectionHeadingIndexes.length !== 1) {
        return {
            ...buildUnavailableDecisions(taskPath, 'missing', sourceSha256),
            status: 'invalid',
            violations: [`TASK.md must contain exactly one '${OPERATOR_DECISIONS_SECTION_HEADING}' section; found ${sectionHeadingIndexes.length}.`]
        };
    }
    const sectionHeadingIndex = sectionHeadingIndexes[0];
    const nextSectionOffset = sourceLines.slice(sectionHeadingIndex + 1)
        .findIndex((line) => /^##\s+/u.test(line.trim()));
    const sectionEndIndex = nextSectionOffset < 0
        ? sourceLines.length
        : sectionHeadingIndex + 1 + nextSectionOffset;
    const sourceSectionSha256 = stringSha256(
        sourceLines.slice(sectionHeadingIndex + 1, sectionEndIndex).join('\n')
    ) || null;
    const records: ReviewContextOperatorDecisionRecord[] = [];
    const violations: string[] = [];
    const recordIdentities = new Set<string>();
    for (const [index, rawLine] of sourceLines.entries()) {
        const candidate = rawLine.match(DECISION_CANDIDATE_PATTERN);
        if (!candidate || candidate[1] !== taskId) {
            continue;
        }
        if (index <= sectionHeadingIndex || index >= sectionEndIndex) {
            violations.push(`Operator decision candidate for ${taskId} at TASK.md line ${index + 1} is outside the '${OPERATOR_DECISIONS_SECTION_HEADING}' section.`);
            continue;
        }
        const match = rawLine.match(DECISION_LINE_PATTERN);
        if (!match || match[1] !== taskId) {
            violations.push(`Malformed operator decision for ${taskId} at TASK.md line ${index + 1}; expected '- ${taskId} operator decision (YYYY-MM-DD): <text>'.`);
            continue;
        }
        const [, recordTaskId, date, text] = match;
        if (!isValidIsoDate(date)) {
            violations.push(`Malformed operator decision date '${date}' for ${taskId} at TASK.md line ${index + 1}.`);
            continue;
        }
        if (text.length > MAX_TASK_DECISION_TEXT_CHARS) {
            violations.push(`Operator decision for ${taskId} at TASK.md line ${index + 1} exceeds ${MAX_TASK_DECISION_TEXT_CHARS} characters.`);
            continue;
        }
        const recordSha256 = stringSha256(rawLine) || '';
        const recordIdentity = JSON.stringify([recordTaskId, date, text]);
        if (recordIdentities.has(recordIdentity)) {
            violations.push(`Duplicate operator decision for ${taskId} at TASK.md line ${index + 1}; record sha256=${recordSha256}.`);
            continue;
        }
        recordIdentities.add(recordIdentity);
        records.push({
            task_id: recordTaskId,
            date,
            text,
            source_line: index + 1,
            record_sha256: recordSha256
        });
    }

    if (records.length > MAX_TASK_DECISION_RECORDS) {
        violations.push(`TASK.md contains ${records.length} operator decisions for ${taskId}; maximum is ${MAX_TASK_DECISION_RECORDS}.`);
    }
    for (let index = 1; index < records.length; index += 1) {
        if (records[index].date < records[index - 1].date) {
            violations.push(`Operator decisions for ${taskId} are ambiguously ordered: ${records[index].date} follows ${records[index - 1].date} in source order.`);
        }
        if (records[index].date === records[index - 1].date && records[index].text !== records[index - 1].text) {
            violations.push(`Operator decisions for ${taskId} have conflicting records dated ${records[index].date}; use distinct dates to establish precedence.`);
        }
    }

    const validRecords = records.slice(0, MAX_TASK_DECISION_RECORDS);
    if (validRecords.length === 0 && violations.length === 0) {
        return buildUnavailableDecisions(
            taskPath,
            'missing',
            sourceSha256,
            `TASK.md has no task-scoped operator decision for ${taskId}; add '- ${taskId} operator decision (YYYY-MM-DD): <text>' before relying on row criteria.`
        );
    }
    return {
        status: violations.length > 0 ? 'invalid' : 'available',
        source_path: normalizePath(taskPath),
        source_sha256: sourceSha256,
        source_section_sha256: sourceSectionSha256,
        ordering: 'source_line_ascending',
        current: violations.length === 0 ? validRecords.at(-1) || null : null,
        records: validRecords,
        warnings: [],
        violations
    };
}
