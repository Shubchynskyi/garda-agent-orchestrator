import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from './build';

export type ReleaseArchiveKind = 'source' | 'evidence';

export interface ReleaseArchiveEntry {
    relativePath: string;
    size: number;
    sha256: string;
}

export interface ReleaseArchivePlan {
    kind: ReleaseArchiveKind;
    repoRoot: string;
    outputPath: string;
    entries: ReleaseArchiveEntry[];
}

const DEFAULT_OUTPUT_DIR = 'release-archives';
const MANIFEST_ENTRY_PATH = 'ARCHIVE-MANIFEST.json';
const SOURCE_EXCLUDED_PREFIXES = Object.freeze([
    '.node-build/',
    '.scripts-build/',
    '.scripts-build.lock/',
    'coverage/',
    'dist/',
    'garda-agent-orchestrator/runtime/',
    'node_modules/',
    'release-archives/',
    'runtime/'
]);
const EVIDENCE_INCLUDED_PREFIXES = Object.freeze([
    'coverage/',
    'garda-agent-orchestrator/runtime/manual-validation/',
    'garda-agent-orchestrator/runtime/metrics/',
    'garda-agent-orchestrator/runtime/project-memory/',
    'garda-agent-orchestrator/runtime/reports/',
    'garda-agent-orchestrator/runtime/reviews/',
    'garda-agent-orchestrator/runtime/task-events/',
    'garda-agent-orchestrator/runtime/task-ledger/'
]);
const SECRET_PATH_RE = /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|id_rsa$|credentials?(?:\.|$)|secrets?(?:\.|$)|tokens?(?:\.|$)|.*\.(?:key|pem|p12|pfx))$/iu;
const SECRET_CONTENT_RES = Object.freeze([
    /(?:^|[\r\n])\s*(?:export\s+)?["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/\-=]{12,}/iu,
    /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/\-=]{12,}/iu,
    /\bhttps?:\/\/[^\s/:@]+:[^\s/@]{6,}@[^\s]+/iu,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u
]);
const EVIDENCE_SECRET_SCAN_CHUNK_BYTES = 1024 * 1024;
const EVIDENCE_SECRET_SCAN_OVERLAP_BYTES = 4096;

function normalizeRelativePath(value: string): string {
    return value.split(path.sep).join('/').replace(/^\.\//u, '');
}

function assertSafeRelativePath(relativePath: string): void {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').includes('..')) {
        throw new Error(`Unsafe archive path: ${relativePath}`);
    }
}

function runGit(repoRoot: string, args: string[]): string {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
    }
    return String(result.stdout || '');
}

function hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isExcludedSourcePath(relativePath: string): boolean {
    return SOURCE_EXCLUDED_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

function isSensitiveEvidencePath(relativePath: string): boolean {
    return SECRET_PATH_RE.test(relativePath) || relativePath === 'garda-agent-orchestrator/runtime/init-answers.json';
}

function isGeneratedReviewSupportPath(relativePath: string): boolean {
    if (!relativePath.startsWith('garda-agent-orchestrator/runtime/reviews/')) {
        return false;
    }
    const basename = path.posix.basename(relativePath);
    return /-(?:review-context|role-prompt|prompt-template|output-template|evidence-manifest|scoped)(?:[.-]|$)/u.test(basename);
}

function isProbablyTextContent(content: Buffer): boolean {
    return !content.subarray(0, Math.min(content.length, 4096)).includes(0);
}

function assertNoSensitiveEvidenceContent(filePath: string, relativePath: string): void {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
        return;
    }

    const descriptor = fs.openSync(filePath, 'r');
    try {
        const probe = Buffer.alloc(Math.min(4096, stat.size));
        fs.readSync(descriptor, probe, 0, probe.length, 0);
        if (!isProbablyTextContent(probe)) {
            return;
        }

        const buffer = Buffer.alloc(EVIDENCE_SECRET_SCAN_CHUNK_BYTES);
        let position = 0;
        let overlap = '';
        while (position < stat.size) {
            const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
            if (bytesRead === 0) {
                break;
            }
            position += bytesRead;
            const text = `${overlap}${buffer.subarray(0, bytesRead).toString('utf8')}`;
            if (SECRET_CONTENT_RES.some((pattern) => pattern.test(text))) {
                throw new Error(`Refusing to archive evidence file with credential-like content: ${relativePath}`);
            }
            overlap = text.slice(-EVIDENCE_SECRET_SCAN_OVERLAP_BYTES);
        }
    } finally {
        fs.closeSync(descriptor);
    }
}

function assertNoSensitiveEvidencePathOrContent(filePath: string, relativePath: string): void {
    if (isSensitiveEvidencePath(relativePath) || isGeneratedReviewSupportPath(relativePath)) {
        return;
    }

    assertNoSensitiveEvidenceContent(filePath, relativePath);
}

function listTrackedSourceFiles(repoRoot: string): string[] {
    return runGit(repoRoot, ['ls-files', '-z'])
        .split('\0')
        .map((entry) => normalizeRelativePath(entry.trim()))
        .filter(Boolean)
        .filter((entry) => !isExcludedSourcePath(entry))
        .sort();
}

function listFilesUnder(rootPath: string): string[] {
    if (!fs.existsSync(rootPath)) {
        return [];
    }
    const stat = fs.lstatSync(rootPath);
    if (stat.isFile() || stat.isSymbolicLink()) {
        return [rootPath];
    }
    if (!stat.isDirectory()) {
        return [];
    }

    const files: string[] = [];
    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFilesUnder(entryPath));
            continue;
        }
        if (entry.isFile() || entry.isSymbolicLink()) {
            files.push(entryPath);
        }
    }
    return files;
}

function listEvidenceFiles(repoRoot: string): string[] {
    const entries = new Set<string>();
    for (const prefix of EVIDENCE_INCLUDED_PREFIXES) {
        const absoluteRoot = path.join(repoRoot, ...prefix.split('/').filter(Boolean));
        for (const filePath of listFilesUnder(absoluteRoot)) {
            const relativePath = normalizeRelativePath(path.relative(repoRoot, filePath));
            if (isSensitiveEvidencePath(relativePath) || isGeneratedReviewSupportPath(relativePath)) {
                continue;
            }
            assertNoSensitiveEvidencePathOrContent(filePath, relativePath);
            entries.add(relativePath);
        }
    }
    return [...entries].sort();
}

function buildEntries(repoRoot: string, relativePaths: readonly string[]): ReleaseArchiveEntry[] {
    return relativePaths.map((relativePath) => {
        assertSafeRelativePath(relativePath);
        const absolutePath = path.join(repoRoot, ...relativePath.split('/'));
        const stat = fs.lstatSync(absolutePath);
        if (!stat.isFile() && !stat.isSymbolicLink()) {
            throw new Error(`Archive entry must be a file or symlink: ${relativePath}`);
        }
        return {
            relativePath,
            size: stat.isSymbolicLink() ? Buffer.byteLength(fs.readlinkSync(absolutePath), 'utf8') : stat.size,
            sha256: stat.isSymbolicLink()
                ? crypto.createHash('sha256').update(`symlink:${fs.readlinkSync(absolutePath)}`).digest('hex')
                : hashFile(absolutePath)
        };
    });
}

function resolveDefaultOutputPath(repoRoot: string, kind: ReleaseArchiveKind): string {
    return path.join(repoRoot, DEFAULT_OUTPUT_DIR, `garda-agent-orchestrator-${kind}.tar`);
}

export function buildReleaseArchivePlan(kind: ReleaseArchiveKind, repoRoot = getRepoRoot(), outputPath?: string): ReleaseArchivePlan {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const relativePaths = kind === 'source'
        ? listTrackedSourceFiles(normalizedRepoRoot)
        : listEvidenceFiles(normalizedRepoRoot);
    const resolvedOutputPath = path.resolve(outputPath || resolveDefaultOutputPath(normalizedRepoRoot, kind));

    return {
        kind,
        repoRoot: normalizedRepoRoot,
        outputPath: resolvedOutputPath,
        entries: buildEntries(normalizedRepoRoot, relativePaths)
    };
}

function formatTarNumber(value: number, length: number): Buffer {
    const octal = value.toString(8);
    const text = `${octal.padStart(length - 1, '0')}\0`;
    return Buffer.from(text, 'ascii');
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
    const payload = Buffer.from(value, 'utf8');
    payload.copy(header, offset, 0, Math.min(payload.length, length));
}

function splitTarPath(relativePath: string): { name: string; prefix: string } {
    const pathBytes = Buffer.byteLength(relativePath, 'utf8');
    if (pathBytes <= 100) {
        return { name: relativePath, prefix: '' };
    }
    for (let index = relativePath.lastIndexOf('/'); index > 0; index = relativePath.lastIndexOf('/', index - 1)) {
        const prefix = relativePath.slice(0, index);
        const name = relativePath.slice(index + 1);
        if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
            return { name, prefix };
        }
    }
    return { name: relativePath.slice(-100), prefix: '' };
}

function buildTarHeader(relativePath: string, size: number, typeFlag: string, linkName = ''): Buffer {
    const header = Buffer.alloc(512, 0);
    const { name, prefix } = splitTarPath(relativePath);
    writeTarString(header, 0, 100, name);
    formatTarNumber(typeFlag === '2' ? 0o777 : 0o644, 8).copy(header, 100);
    formatTarNumber(0, 8).copy(header, 108);
    formatTarNumber(0, 8).copy(header, 116);
    formatTarNumber(size, 12).copy(header, 124);
    formatTarNumber(0, 12).copy(header, 136);
    Buffer.from('        ', 'ascii').copy(header, 148);
    writeTarString(header, 156, 1, typeFlag);
    writeTarString(header, 157, 100, linkName);
    writeTarString(header, 257, 6, 'ustar');
    writeTarString(header, 263, 2, '00');
    writeTarString(header, 345, 155, prefix);

    let checksum = 0;
    for (const byte of header) {
        checksum += byte;
    }
    const checksumText = checksum.toString(8).padStart(6, '0');
    Buffer.from(`${checksumText}\0 `, 'ascii').copy(header, 148);
    return header;
}

function padTarContent(content: Buffer): Buffer {
    const remainder = content.length % 512;
    if (remainder === 0) {
        return content;
    }
    return Buffer.concat([content, Buffer.alloc(512 - remainder, 0)]);
}

function buildPaxPathContent(relativePath: string): Buffer {
    let length = 0;
    let line = '';
    do {
        line = `${length} path=${relativePath}\n`;
        length = Buffer.byteLength(line, 'utf8');
        line = `${length} path=${relativePath}\n`;
    } while (Buffer.byteLength(line, 'utf8') !== length);
    return Buffer.from(line, 'utf8');
}

function maybeBuildPaxHeader(relativePath: string): Buffer[] {
    if (Buffer.byteLength(relativePath, 'utf8') <= 100 || splitTarPath(relativePath).prefix) {
        return [];
    }
    const paxContent = buildPaxPathContent(relativePath);
    const paxName = `PaxHeaders/${crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}.pax`;
    return [buildTarHeader(paxName, paxContent.length, 'x'), padTarContent(paxContent)];
}

function buildManifestContent(plan: ReleaseArchivePlan): Buffer {
    const payload = {
        schema_version: 1,
        archive_kind: plan.kind,
        deterministic: true,
        entry_count: plan.entries.length,
        entries: plan.entries
    };
    return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildTarFileEntry(repoRoot: string, relativePath: string, contentOverride?: Buffer): Buffer[] {
    const absolutePath = path.join(repoRoot, ...relativePath.split('/'));
    const stat = contentOverride ? null : fs.lstatSync(absolutePath);
    const isSymlink = stat?.isSymbolicLink() || false;
    const content = contentOverride
        || (isSymlink ? Buffer.alloc(0) : fs.readFileSync(absolutePath));
    const linkName = isSymlink ? fs.readlinkSync(absolutePath) : '';
    return [
        ...maybeBuildPaxHeader(relativePath),
        buildTarHeader(relativePath, content.length, isSymlink ? '2' : '0', linkName),
        padTarContent(content)
    ];
}

export function createReleaseArchive(kind: ReleaseArchiveKind, repoRoot = getRepoRoot(), outputPath?: string): ReleaseArchivePlan {
    const plan = buildReleaseArchivePlan(kind, repoRoot, outputPath);
    const parts: Buffer[] = [];
    parts.push(...buildTarFileEntry(plan.repoRoot, MANIFEST_ENTRY_PATH, buildManifestContent(plan)));
    for (const entry of plan.entries) {
        parts.push(...buildTarFileEntry(plan.repoRoot, entry.relativePath));
    }
    parts.push(Buffer.alloc(1024, 0));
    fs.mkdirSync(path.dirname(plan.outputPath), { recursive: true });
    fs.writeFileSync(plan.outputPath, Buffer.concat(parts));
    return plan;
}

function parseCliArgs(argv: readonly string[]): { kind: ReleaseArchiveKind | null; outputPath?: string } {
    const kind = argv[0] === 'source' || argv[0] === 'evidence' ? argv[0] : null;
    let outputPath: string | undefined;
    for (let index = 1; index < argv.length; index += 1) {
        if (argv[index] === '--output') {
            outputPath = argv[index + 1];
            index += 1;
            continue;
        }
        throw new Error(`Unknown archive-release argument: ${argv[index]}`);
    }
    return { kind, outputPath };
}

export function runReleaseArchiveCli(argv = process.argv.slice(2)): void {
    const { kind, outputPath } = parseCliArgs(argv);
    if (kind === null) {
        console.error('Usage: archive-release.js <source|evidence> [--output <path>]');
        process.exit(1);
    }
    const plan = createReleaseArchive(kind, getRepoRoot(), outputPath);
    console.log('RELEASE_ARCHIVE_CREATED');
    console.log(`ArchiveKind: ${plan.kind}`);
    console.log(`ArchivePath: ${plan.outputPath}`);
    console.log(`EntryCount: ${plan.entries.length}`);
}

if (require.main === module) {
    runReleaseArchiveCli();
}
