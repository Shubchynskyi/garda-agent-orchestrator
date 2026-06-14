import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDirectory, pathExists } from '../core/filesystem';

export interface MaterializationStage {
    readonly label: string;
    readonly apply: () => void;
    readonly rollback?: () => void;
}

export interface MaterializationStageExecution {
    readonly label: string;
    readonly status: 'applied' | 'dry-run';
}

export interface ApplyMaterializationStageOptions {
    readonly dryRun?: boolean;
}

export function applyMaterializationStage(
    stage: MaterializationStage,
    options: ApplyMaterializationStageOptions = {}
): MaterializationStageExecution {
    if (options.dryRun) {
        return { label: stage.label, status: 'dry-run' };
    }

    try {
        stage.apply();
        return { label: stage.label, status: 'applied' };
    } catch (error: unknown) {
        try {
            stage.rollback?.();
        } catch (rollbackError: unknown) {
            const applyMessage = error instanceof Error ? error.message : String(error);
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(
                `Materialization stage '${stage.label}' failed: ${applyMessage}; rollback failed: ${rollbackMessage}`
            );
        }
        throw error;
    }
}

export function createWriteTextFileStage(filePath: string, content: string): MaterializationStage {
    const existedBefore = pathExists(filePath);
    const previousContent = existedBefore ? fs.readFileSync(filePath, 'utf8') : null;
    const existingParentBoundary = findExistingParent(path.dirname(filePath));
    return {
        label: `write:${normalizeStagePath(filePath)}`,
        apply: () => {
            ensureDirectory(path.dirname(filePath));
            fs.writeFileSync(filePath, content, 'utf8');
        },
        rollback: () => {
            if (existedBefore) {
                ensureDirectory(path.dirname(filePath));
                fs.writeFileSync(filePath, previousContent ?? '', 'utf8');
            } else {
                fs.rmSync(filePath, { force: true });
                removeEmptyParents(path.dirname(filePath), existingParentBoundary);
            }
        }
    };
}

export function createCopyFileStage(sourcePath: string, destinationPath: string): MaterializationStage {
    const existedBefore = pathExists(destinationPath);
    const previousContent = existedBefore ? fs.readFileSync(destinationPath) : null;
    const existingParentBoundary = findExistingParent(path.dirname(destinationPath));
    return {
        label: `copy:${normalizeStagePath(sourcePath)}->${normalizeStagePath(destinationPath)}`,
        apply: () => {
            ensureDirectory(path.dirname(destinationPath));
            fs.copyFileSync(sourcePath, destinationPath);
        },
        rollback: () => {
            if (existedBefore && previousContent) {
                ensureDirectory(path.dirname(destinationPath));
                fs.writeFileSync(destinationPath, previousContent);
            } else {
                fs.rmSync(destinationPath, { force: true });
                removeEmptyParents(path.dirname(destinationPath), existingParentBoundary);
            }
        }
    };
}

export function createRemoveFileStage(filePath: string): MaterializationStage {
    const existedBefore = pathExists(filePath);
    const previousContent = existedBefore && fs.statSync(filePath).isFile()
        ? fs.readFileSync(filePath)
        : null;
    return {
        label: `remove:${normalizeStagePath(filePath)}`,
        apply: () => {
            fs.rmSync(filePath, { force: true });
        },
        rollback: () => {
            if (existedBefore && previousContent) {
                ensureDirectory(path.dirname(filePath));
                fs.writeFileSync(filePath, previousContent);
            }
        }
    };
}

function normalizeStagePath(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/');
}

function findExistingParent(startDir: string): string {
    let current = path.resolve(startDir);
    while (!pathExists(current)) {
        const next = path.dirname(current);
        if (next === current) {
            return current;
        }
        current = next;
    }
    return current;
}

function removeEmptyParents(startDir: string, boundaryDir: string): void {
    let current = path.resolve(startDir);
    const boundary = path.resolve(boundaryDir);
    while (pathExists(current) && fs.statSync(current).isDirectory() && fs.readdirSync(current).length === 0) {
        if (current === boundary) {
            return;
        }
        const next = path.dirname(current);
        if (next === current) {
            return;
        }
        fs.rmdirSync(current);
        current = next;
    }
}
