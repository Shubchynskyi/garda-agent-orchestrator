import * as path from 'node:path';
import { resolveAgentInitStateRelativePath } from '../core/constants';
import { pathExists } from '../core/fs';
import { readJsonFile, writeJsonFile } from '../core/json';

export const AGENT_INIT_STATE_VERSION = 1;

export interface AgentInitState {
    Version: number;
    UpdatedAt: string;
    OrchestratorVersion: string | null;
    AssistantLanguage: string | null;
    SourceOfTruth: string | null;
    AssistantLanguageConfirmed: boolean;
    ActiveAgentFilesConfirmed: boolean;
    ProjectRulesUpdated: boolean;
    SkillsPromptCompleted: boolean;
    VerificationPassed: boolean;
    ManifestValidationPassed: boolean;
    ActiveAgentFiles: string[];
}

interface AgentInitStateReadResult {
    statePath: string;
    state: AgentInitState | null;
    error: string | null;
}

interface BuildRefreshAgentInitStateOptions {
    previousState: AgentInitState | null | undefined;
    preserveExistingCheckpoints: boolean;
    assistantLanguage: string | null;
    sourceOfTruth: string | null;
    orchestratorVersion?: string | null;
    activeAgentFiles: string[];
    verificationPassed?: boolean | null;
    manifestValidationPassed?: boolean | null;
    autoConfirmPrompts?: boolean;
    autoAcceptRules?: boolean;
}

function normalizeBoolean(value: unknown, fieldName: string): boolean {
    if (value === true || value === false) {
        return value;
    }

    throw new Error(`${fieldName} must be a boolean.`);
}

function normalizeOptionalStringArray(value: unknown, fieldName: string): string[] {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array.`);
    }

    const normalized: string[] = [];
    for (const item of value) {
        const text = String(item || '').trim();
        if (!text) {
            continue;
        }
        if (!normalized.includes(text)) {
            normalized.push(text);
        }
    }

    return normalized;
}

function normalizeOptionalString(value: unknown): string | null {
    if (value === undefined || value === null) {
        return null;
    }

    const text = String(value).trim();
    return text || null;
}

export function areStringArraysEqual(left: unknown, right: unknown): boolean {
    const leftNormalized = normalizeOptionalStringArray(left, 'left');
    const rightNormalized = normalizeOptionalStringArray(right, 'right');
    if (leftNormalized.length !== rightNormalized.length) {
        return false;
    }

    for (let index = 0; index < leftNormalized.length; index += 1) {
        if (leftNormalized[index] !== rightNormalized[index]) {
            return false;
        }
    }

    return true;
}

export function validateAgentInitState(input: unknown): AgentInitState {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Agent init state must be a JSON object.');
    }

    const raw = input as Record<string, unknown>;

    return {
        Version: raw.Version === undefined ? AGENT_INIT_STATE_VERSION : Number(raw.Version),
        UpdatedAt: String(raw.UpdatedAt || new Date().toISOString()),
        OrchestratorVersion: normalizeOptionalString(raw.OrchestratorVersion),
        AssistantLanguage: normalizeOptionalString(raw.AssistantLanguage),
        SourceOfTruth: normalizeOptionalString(raw.SourceOfTruth),
        AssistantLanguageConfirmed: normalizeBoolean(raw.AssistantLanguageConfirmed, 'AssistantLanguageConfirmed'),
        ActiveAgentFilesConfirmed: normalizeBoolean(raw.ActiveAgentFilesConfirmed, 'ActiveAgentFilesConfirmed'),
        ProjectRulesUpdated: normalizeBoolean(raw.ProjectRulesUpdated, 'ProjectRulesUpdated'),
        SkillsPromptCompleted: normalizeBoolean(raw.SkillsPromptCompleted, 'SkillsPromptCompleted'),
        VerificationPassed: normalizeBoolean(raw.VerificationPassed, 'VerificationPassed'),
        ManifestValidationPassed: normalizeBoolean(raw.ManifestValidationPassed, 'ManifestValidationPassed'),
        ActiveAgentFiles: normalizeOptionalStringArray(raw.ActiveAgentFiles, 'ActiveAgentFiles')
    };
}

export function createAgentInitState(overrides: Partial<AgentInitState> = {}): AgentInitState {
    return validateAgentInitState({
        Version: AGENT_INIT_STATE_VERSION,
        UpdatedAt: new Date().toISOString(),
        OrchestratorVersion: null,
        AssistantLanguage: null,
        SourceOfTruth: null,
        AssistantLanguageConfirmed: false,
        ActiveAgentFilesConfirmed: false,
        ProjectRulesUpdated: false,
        SkillsPromptCompleted: false,
        VerificationPassed: false,
        ManifestValidationPassed: false,
        ActiveAgentFiles: [],
        ...overrides
    });
}

export function buildRefreshAgentInitState(options: BuildRefreshAgentInitStateOptions): AgentInitState {
    const {
        previousState,
        preserveExistingCheckpoints,
        assistantLanguage,
        sourceOfTruth,
        orchestratorVersion = null,
        activeAgentFiles,
        verificationPassed = null,
        manifestValidationPassed = null,
        autoConfirmPrompts = false,
        autoAcceptRules = false
    } = options;

    const canPreserve = Boolean(preserveExistingCheckpoints && previousState);
    const preservedState = canPreserve ? previousState as AgentInitState : null;

    return createAgentInitState({
        AssistantLanguage: assistantLanguage,
        SourceOfTruth: sourceOfTruth,
        OrchestratorVersion: orchestratorVersion,
        AssistantLanguageConfirmed: true,
        ActiveAgentFilesConfirmed: canPreserve
            ? (autoConfirmPrompts ? true : preservedState!.ActiveAgentFilesConfirmed)
            : false,
        ProjectRulesUpdated: canPreserve
            ? (autoAcceptRules ? true : preservedState!.ProjectRulesUpdated)
            : false,
        SkillsPromptCompleted: canPreserve
            ? (autoConfirmPrompts ? true : preservedState!.SkillsPromptCompleted)
            : false,
        VerificationPassed: canPreserve
            ? (verificationPassed === null ? preservedState!.VerificationPassed : verificationPassed)
            : false,
        ManifestValidationPassed: canPreserve
            ? (manifestValidationPassed === null ? preservedState!.ManifestValidationPassed : manifestValidationPassed)
            : false,
        ActiveAgentFiles: activeAgentFiles
    });
}

export function getAgentInitStatePath(targetRoot: string, relativePath: string = resolveAgentInitStateRelativePath()): string {
    return path.isAbsolute(relativePath)
        ? relativePath
        : path.resolve(targetRoot, relativePath);
}

export function readAgentInitStateSafe(
    targetRoot: string,
    relativePath: string = resolveAgentInitStateRelativePath()
): AgentInitStateReadResult {
    const statePath = getAgentInitStatePath(targetRoot, relativePath);
    if (!pathExists(statePath)) {
        return {
            statePath,
            state: null,
            error: null
        };
    }

    try {
        return {
            statePath,
            state: validateAgentInitState(readJsonFile(statePath)),
            error: null
        };
    } catch (error: unknown) {
        return {
            statePath,
            state: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function writeAgentInitState(
    targetRoot: string,
    state: unknown,
    relativePath: string = resolveAgentInitStateRelativePath()
): string {
    const statePath = getAgentInitStatePath(targetRoot, relativePath);
    writeJsonFile(statePath, validateAgentInitState(state));
    return statePath;
}

export function doesAgentInitStateMatchAnswers(
    state: AgentInitState | null | undefined,
    answers: Record<string, unknown> | null | undefined,
    currentOrchestratorVersion: string | null = null
): boolean {
    if (!state) {
        return false;
    }

    const expectedSourceOfTruth = normalizeOptionalString(answers && answers.SourceOfTruth);
    const expectedActiveAgentFiles = normalizeOptionalStringArray(
        answers && answers.ActiveAgentFiles,
        'ActiveAgentFiles'
    );
    const expectedVersion = normalizeOptionalString(currentOrchestratorVersion);
    const actualVersion = normalizeOptionalString(state.OrchestratorVersion);

    const versionMatches = !expectedVersion || actualVersion === expectedVersion;

    return (
        versionMatches
        && normalizeOptionalString(state.AssistantLanguage) === normalizeOptionalString(answers && answers.AssistantLanguage)
        && normalizeOptionalString(state.SourceOfTruth) === expectedSourceOfTruth
        && areStringArraysEqual(state.ActiveAgentFiles, expectedActiveAgentFiles)
    );
}
