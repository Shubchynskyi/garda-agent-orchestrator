import * as path from 'node:path';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { ensureDirectory, pathExists, readTextFile } from '../../core/filesystem';
import { buildTaskContentWithExistingQueue } from '../content-builders';
import type { InstallFilesystemStage } from './install-contracts';

export interface RunInstallTaskStageOptions {
    sourceRoot: string;
    targetRoot: string;
    dryRun: boolean;
    preserveExisting: boolean;
    answerDependentOnly: boolean;
    filesystem: InstallFilesystemStage;
}

export function runInstallTaskStage(options: RunInstallTaskStageOptions): void {
    const {
        sourceRoot,
        targetRoot,
        dryRun,
        preserveExisting,
        answerDependentOnly,
        filesystem
    } = options;
    const { metrics } = filesystem;

    if (!answerDependentOnly) {
        for (const relativePath of [TASK_QUEUE_FILENAME]) {
            const sourcePath = path.join(sourceRoot, relativePath);
            if (!pathExists(sourcePath)) continue;
            const destPath = path.join(targetRoot, relativePath);
            const destDir = path.dirname(destPath);
            if (!pathExists(destDir) && !dryRun) {
                ensureDirectory(destDir);
            }

            if (pathExists(destPath)) {
                const templateContent = filesystem.getTemplateContent(sourcePath, relativePath);
                if (templateContent !== null) {
                    const existingContent = readTextFile(destPath);
                    const nextContent = buildTaskContentWithExistingQueue(
                        templateContent,
                        existingContent
                    );
                    if (preserveExisting) metrics.skippedExisting++;
                    if (nextContent && nextContent !== existingContent) {
                        filesystem.backupFile(destPath, relativePath);
                        if (!dryRun) {
                            filesystem.writeTextFile(destPath, nextContent);
                        }
                        metrics.aligned++;
                    }
                    if (!preserveExisting) metrics.deployed++;
                }
                continue;
            }

            const content = filesystem.getTemplateContent(sourcePath, relativePath);
            if (content && !dryRun) {
                filesystem.writeTextFile(destPath, content);
            }
            metrics.deployed++;
        }
        return;
    }

    const taskSourcePath = path.join(sourceRoot, TASK_QUEUE_FILENAME);
    const taskDestPath = path.join(targetRoot, TASK_QUEUE_FILENAME);
    if (!pathExists(taskSourcePath)) {
        return;
    }
    if (pathExists(taskDestPath)) {
        const templateContent = filesystem.getTemplateContent(
            taskSourcePath,
            TASK_QUEUE_FILENAME
        );
        if (
            templateContent !== null
            && filesystem.syncTaskFileOnDisk(
                taskDestPath,
                TASK_QUEUE_FILENAME,
                templateContent
            )
        ) {
            metrics.aligned++;
        }
        return;
    }
    if (!dryRun) {
        ensureDirectory(path.dirname(taskDestPath));
        const content = filesystem.getTemplateContent(taskSourcePath, TASK_QUEUE_FILENAME);
        if (content) {
            filesystem.writeTextFile(taskDestPath, content);
        }
    }
    metrics.deployed++;
}
