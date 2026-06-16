import * as path from 'node:path';
import { pathExists } from '../../core/filesystem';

function formatInstallBackupTimestamp(date: Date): string {
    const pad2 = (value: number): string => String(value).padStart(2, '0');
    const pad3 = (value: number): string => String(value).padStart(3, '0');
    return [
        String(date.getUTCFullYear()),
        pad2(date.getUTCMonth() + 1),
        pad2(date.getUTCDate())
    ].join('') + '-' + [
        pad2(date.getUTCHours()),
        pad2(date.getUTCMinutes()),
        pad2(date.getUTCSeconds())
    ].join('') + '-' + pad3(date.getUTCMilliseconds());
}

export function createUniqueInstallBackupRoot(bundleRoot: string): { timestamp: string; backupRoot: string } {
    const backupsRoot = path.join(bundleRoot, 'runtime', 'backups');
    const baseTimestamp = formatInstallBackupTimestamp(new Date());
    let candidateTimestamp = baseTimestamp;
    let suffix = 1;

    while (pathExists(path.join(backupsRoot, candidateTimestamp))) {
        candidateTimestamp = `${baseTimestamp}-${String(suffix).padStart(2, '0')}`;
        suffix += 1;
    }

    return {
        timestamp: candidateTimestamp,
        backupRoot: path.join(backupsRoot, candidateTimestamp)
    };
}
