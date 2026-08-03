import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SqliteWalFilesystemAssessment =
    | { readonly status: 'safe' }
    | { readonly status: 'unsafe'; readonly diagnostic: string }
    | { readonly status: 'unavailable'; readonly diagnostic: string };

type WindowsDriveMapping = 'local' | 'network' | 'unknown';

interface WindowsDriveMappingCommandResult {
    readonly error?: unknown;
    readonly status: number | null;
    readonly stdout?: string | Buffer | null;
}

type WindowsDriveMappingCommand = (drive: string) => WindowsDriveMappingCommandResult;

interface SqliteWalFilesystemDependencies {
    readonly platform: NodeJS.Platform;
    readonly pathExists: (candidatePath: string) => boolean;
    readonly realpath: (candidatePath: string) => string;
    readonly statfsType: (candidatePath: string) => number;
    readonly windowsDriveMapping: (drive: string) => WindowsDriveMapping;
}

// Network, clustered, and userspace filesystems whose locking semantics are not
// accepted for the catalog's three-file WAL recovery unit.
const SQLITE_WAL_UNSAFE_FILESYSTEM_TYPES = new Set<number>([
    0x0000517b, // SMB
    0x0000564c, // NCP
    0x00006969, // NFS
    0x00c36400, // Ceph
    0x01021997, // 9P
    0x01161970, // GFS2
    0x0bd00bd0, // Lustre
    0x19830326, // BeeGFS
    0x20030528, // PVFS2
    0x47504653, // GPFS
    0x5346414f, // AFS
    0x65735546, // FUSE (including SSHFS and virtiofs)
    0x73757245, // Coda
    0x7461636f, // OCFS2
    0x786f4256, // VirtualBox shared folders
    0xfe534d42, // SMB2
    0xff534d42 // CIFS
]);

function isUncPath(candidatePath: string): boolean {
    const windowsPath = String(candidatePath).split('/').join(path.win32.sep);
    const upper = windowsPath.toUpperCase();
    return upper.startsWith('\\\\?\\UNC\\')
        || (windowsPath.startsWith('\\\\') && !upper.startsWith('\\\\?\\'));
}

function runWindowsDriveMappingCommand(drive: string): WindowsDriveMappingCommandResult {
    return spawnSync('net.exe', ['use', drive], {
        stdio: 'ignore',
        timeout: 250,
        windowsHide: true
    });
}

function runWindowsDriveTypeCommand(drive: string): WindowsDriveMappingCommandResult {
    return spawnSync(
        'powershell.exe',
        [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `[int]([System.IO.DriveInfo]::new('${drive}\\').DriveType)`
        ],
        {
            encoding: 'utf8',
            timeout: 3_000,
            windowsHide: true
        }
    );
}

function classifyWindowsDriveType(result: WindowsDriveMappingCommandResult): WindowsDriveMapping {
    if (result.error || result.status !== 0) return 'unknown';
    const driveType = Number(String(result.stdout || '').trim());
    if (driveType === 4) return 'network';
    if ([2, 3, 6].includes(driveType)) return 'local';
    return 'unknown';
}

export function probeWindowsDriveMapping(
    drive: string,
    runCommand: WindowsDriveMappingCommand = runWindowsDriveMappingCommand,
    runDriveTypeCommand: WindowsDriveMappingCommand = runWindowsDriveTypeCommand
): WindowsDriveMapping {
    const normalizedDrive = drive.toUpperCase();
    if (!/^[A-Z]:$/u.test(normalizedDrive)) return 'unknown';
    const result = runCommand(normalizedDrive);
    if (!result.error && result.status === 0) return 'network';
    if (!result.error && result.status === 2) return 'local';
    return classifyWindowsDriveType(runDriveTypeCommand(normalizedDrive));
}

const DEFAULT_DEPENDENCIES: SqliteWalFilesystemDependencies = {
    platform: process.platform,
    pathExists: (candidatePath) => fs.existsSync(candidatePath),
    realpath: (candidatePath) => fs.realpathSync.native(candidatePath),
    statfsType: (candidatePath) => Number(fs.statfsSync(candidatePath).type),
    windowsDriveMapping: probeWindowsDriveMapping
};

export function createSqliteWalFilesystemAssessmentSession(
    dependencies: SqliteWalFilesystemDependencies = DEFAULT_DEPENDENCIES
): (candidatePath: string) => SqliteWalFilesystemAssessment {
    const driveMappings = new Map<string, WindowsDriveMapping>();
    const sessionDependencies: SqliteWalFilesystemDependencies = {
        ...dependencies,
        windowsDriveMapping: (drive) => {
            const normalizedDrive = drive.toUpperCase();
            const cached = driveMappings.get(normalizedDrive);
            if (cached) return cached;
            const mapping = dependencies.windowsDriveMapping(normalizedDrive);
            driveMappings.set(normalizedDrive, mapping);
            return mapping;
        }
    };
    return (candidatePath) => assessSqliteWalFilesystem(candidatePath, sessionDependencies);
}

function unsignedFilesystemType(filesystemType: number): number {
    return filesystemType >>> 0;
}

function nearestExistingPath(
    candidatePath: string,
    dependencies: SqliteWalFilesystemDependencies
): string | null {
    const pathApi = dependencies.platform === 'win32' ? path.win32 : path.posix;
    let currentPath = pathApi.resolve(candidatePath);
    while (!dependencies.pathExists(currentPath)) {
        const parentPath = pathApi.dirname(currentPath);
        if (parentPath === currentPath) return null;
        currentPath = parentPath;
    }
    return currentPath;
}

export function assessSqliteWalFilesystem(
    candidatePath: string,
    dependencies: SqliteWalFilesystemDependencies = DEFAULT_DEPENDENCIES
): SqliteWalFilesystemAssessment {
    if (isUncPath(candidatePath)) {
        return { status: 'unsafe', diagnostic: 'SQLite catalog is disabled for UNC network-share paths.' };
    }

    let realPath: string;
    try {
        const existingPath = nearestExistingPath(candidatePath, dependencies);
        if (!existingPath) {
            return { status: 'unavailable', diagnostic: 'Cannot find an existing catalog filesystem ancestor.' };
        }
        realPath = dependencies.realpath(existingPath);
    } catch (error: unknown) {
        const diagnostic = error instanceof Error ? error.message : String(error || 'unknown error');
        return { status: 'unavailable', diagnostic: `Cannot resolve catalog filesystem: ${diagnostic}` };
    }
    if (isUncPath(realPath)) {
        return { status: 'unsafe', diagnostic: 'SQLite catalog resolves to a UNC network-share path.' };
    }

    if (dependencies.platform === 'win32') {
        const drive = path.win32.parse(realPath).root.slice(0, 2);
        if (!/^[A-Z]:$/iu.test(drive)) {
            return { status: 'unavailable', diagnostic: 'Cannot identify the Windows drive that owns the catalog.' };
        }
        const mapping = dependencies.windowsDriveMapping(drive);
        if (mapping === 'network') {
            return { status: 'unsafe', diagnostic: `SQLite catalog is disabled for mapped network drive ${drive}.` };
        }
        if (mapping === 'unknown') {
            return { status: 'unavailable', diagnostic: `Cannot verify whether Windows drive ${drive} is local.` };
        }
        return { status: 'safe' };
    }

    try {
        const filesystemType = unsignedFilesystemType(dependencies.statfsType(realPath));
        if (SQLITE_WAL_UNSAFE_FILESYSTEM_TYPES.has(filesystemType)) {
            return {
                status: 'unsafe',
                diagnostic: `SQLite catalog is disabled for filesystem type 0x${filesystemType.toString(16)}.`
            };
        }
        return { status: 'safe' };
    } catch (error: unknown) {
        const diagnostic = error instanceof Error ? error.message : String(error || 'unknown error');
        return { status: 'unavailable', diagnostic: `Cannot inspect catalog filesystem: ${diagnostic}` };
    }
}
