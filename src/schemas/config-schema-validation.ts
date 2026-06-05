import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensurePlainObject } from './shared';
import { getManagedConfigValidators } from './config-artifacts';
import {
    CONFIG_SCHEMAS,
    OPTIONAL_ROOT_CONFIG_NAMES,
    gardaConfigSchema
} from './config-schema-definitions';

export interface SchemaValidationError {
    path: string;
    message: string;
}

export interface SchemaValidationResult {
    valid: boolean;
    errors: SchemaValidationError[];
}

function validateType(value: unknown, expected: string, jsonPath: string): SchemaValidationError | null {
    if (expected === 'array') {
        return Array.isArray(value) ? null : { path: jsonPath, message: `Expected array, got ${typeof value}.` };
    }
    if (expected === 'integer') {
        return typeof value === 'number' && Number.isInteger(value)
            ? null
            : { path: jsonPath, message: `Expected integer, got ${typeof value}.` };
    }
    if (expected === 'object') {
        return (value !== null && typeof value === 'object' && !Array.isArray(value))
            ? null
            : { path: jsonPath, message: `Expected object, got ${Array.isArray(value) ? 'array' : typeof value}.` };
    }
    return typeof value === expected ? null : { path: jsonPath, message: `Expected ${expected}, got ${typeof value}.` };
}

/**
 * Validates a JSON value against a JSON Schema subset (draft-07).
 *
 * Supports: type, required, properties, additionalProperties, items,
 * enum, minimum, minLength, minProperties, uniqueItems.
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>, rootPath = ''): SchemaValidationResult {
    const errors: SchemaValidationError[] = [];

    const schemaType = schema.type as string | undefined;
    if (schemaType) {
        const typeError = validateType(value, schemaType, rootPath || '$');
        if (typeError) {
            errors.push(typeError);
            return { valid: false, errors };
        }
    }

    if (schemaType === 'string') {
        const str = value as string;
        const minLength = schema.minLength as number | undefined;
        if (minLength !== undefined && str.length < minLength) {
            errors.push({ path: rootPath || '$', message: `String length ${str.length} < minimum ${minLength}.` });
        }
        const enumValues = schema.enum as string[] | undefined;
        if (enumValues && !enumValues.includes(str)) {
            errors.push({ path: rootPath || '$', message: `Value '${str}' not in enum [${enumValues.join(', ')}].` });
        }
    }

    if (schemaType === 'integer' || schemaType === 'number') {
        const num = value as number;
        const minimum = schema.minimum as number | undefined;
        if (minimum !== undefined && num < minimum) {
            errors.push({ path: rootPath || '$', message: `Value ${num} < minimum ${minimum}.` });
        }
    }

    if (schemaType === 'array' && Array.isArray(value)) {
        const itemsSchema = schema.items as Record<string, unknown> | undefined;
        if (itemsSchema) {
            for (let i = 0; i < value.length; i++) {
                const itemResult = validateAgainstSchema(value[i], itemsSchema, `${rootPath}[${i}]`);
                errors.push(...itemResult.errors);
            }
        }
        if (schema.uniqueItems === true) {
            const seen = new Set<string>();
            for (let i = 0; i < value.length; i++) {
                const serialized = JSON.stringify(value[i]);
                if (seen.has(serialized)) {
                    errors.push({ path: `${rootPath}[${i}]`, message: 'Duplicate item in array with uniqueItems constraint.' });
                }
                seen.add(serialized);
            }
        }
    }

    if (schemaType === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
        const required = schema.required as string[] | undefined;
        const additionalProperties = schema.additionalProperties;

        if (required) {
            for (const key of required) {
                if (!(key in obj)) {
                    errors.push({ path: `${rootPath}.${key}`, message: `Required property '${key}' is missing.` });
                }
            }
        }

        if (properties) {
            for (const [key, propSchema] of Object.entries(properties)) {
                if (key in obj) {
                    const propResult = validateAgainstSchema(obj[key], propSchema, `${rootPath}.${key}`);
                    errors.push(...propResult.errors);
                }
            }
        }

        if (additionalProperties === false && properties) {
            const allowed = new Set(Object.keys(properties));
            for (const key of Object.keys(obj)) {
                if (!allowed.has(key)) {
                    errors.push({ path: `${rootPath}.${key}`, message: `Additional property '${key}' is not allowed.` });
                }
            }
        }

        if (typeof additionalProperties === 'object' && additionalProperties !== null) {
            const knownKeys = properties ? new Set(Object.keys(properties)) : new Set<string>();
            for (const [key, val] of Object.entries(obj)) {
                if (!knownKeys.has(key)) {
                    const addlResult = validateAgainstSchema(val, additionalProperties as Record<string, unknown>, `${rootPath}.${key}`);
                    errors.push(...addlResult.errors);
                }
            }
        }

        const minProperties = schema.minProperties as number | undefined;
        if (minProperties !== undefined && Object.keys(obj).length < minProperties) {
            errors.push({ path: rootPath || '$', message: `Object has ${Object.keys(obj).length} properties, minimum is ${minProperties}.` });
        }
    }

    return { valid: errors.length === 0, errors };
}

export interface ConfigValidationReport {
    passed: boolean;
    rootConfigValid: boolean;
    rootConfigPath: string;
    rootErrors: string[];
    configs: ConfigFileReport[];
}

export interface ConfigFileReport {
    name: string;
    filePath: string;
    exists: boolean;
    parseable: boolean;
    schemaValid: boolean;
    runtimeValid: boolean;
    errors: string[];
}

export function validateAllConfigs(
    bundleRoot: string,
    runtimeValidators?: Record<string, (input: unknown) => Record<string, unknown>>
): ConfigValidationReport {
    const configDir = path.join(bundleRoot, 'live', 'config');
    const rootConfigPath = path.join(configDir, 'garda.config.json');

    let rootConfigValid = false;
    const rootErrors: string[] = [];
    let rootConfigMap: Record<string, string> | null = null;

    try {
        const raw = JSON.parse(fs.readFileSync(rootConfigPath, 'utf8'));
        const rootData = ensurePlainObject(raw, 'garda.config.json');
        const schemaResult = validateAgainstSchema(rootData, gardaConfigSchema as Record<string, unknown>);
        if (!schemaResult.valid) {
            for (const err of schemaResult.errors) {
                rootErrors.push(`${err.path}: ${err.message}`);
            }
        } else {
            rootConfigValid = true;
            rootConfigMap = getRootConfigMap(rootData);
        }
    } catch (err) {
        rootErrors.push(String((err as Error).message));
    }

    const configs: ConfigFileReport[] = [];
    let allPassed = rootConfigValid;

    const validators = runtimeValidators ?? getManagedValidators();

    if (!rootConfigValid || !rootConfigMap) {
        return {
            passed: false,
            rootConfigValid,
            rootConfigPath,
            rootErrors,
            configs
        };
    }

    for (const entry of CONFIG_SCHEMAS) {
        const configuredRelativePath = rootConfigMap[entry.name];
        if (!configuredRelativePath) {
            continue;
        }
        const filePath = resolveManifestConfigPath(configDir, rootConfigMap[entry.name]);
        const report: ConfigFileReport = {
            name: entry.name,
            filePath: filePath ?? path.join(configDir, configuredRelativePath),
            exists: false,
            parseable: false,
            schemaValid: false,
            runtimeValid: false,
            errors: []
        };

        try {
            if (!filePath) {
                report.errors.push(`manifest: '${configuredRelativePath}' must resolve inside live/config.`);
                configs.push(report);
                allPassed = false;
                continue;
            }
            if (!fs.existsSync(filePath)) {
                report.errors.push('File not found.');
                configs.push(report);
                allPassed = false;
                continue;
            }
            report.exists = true;

            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            report.parseable = true;

            const schemaResult = validateAgainstSchema(raw, entry.schema as Record<string, unknown>);
            if (schemaResult.valid) {
                report.schemaValid = true;
            } else {
                for (const err of schemaResult.errors) {
                    report.errors.push(`schema: ${err.path}: ${err.message}`);
                }
            }

            const runtimeValidator = validators[entry.name];
            if (runtimeValidator) {
                try {
                    runtimeValidator(raw);
                    report.runtimeValid = true;
                } catch (runtimeErr) {
                    report.errors.push(`runtime: ${(runtimeErr as Error).message}`);
                }
            } else {
                report.runtimeValid = true;
            }
        } catch (err) {
            report.errors.push(`parse: ${(err as Error).message}`);
        }

        if (!report.schemaValid || !report.runtimeValid) {
            allPassed = false;
        }

        configs.push(report);
    }

    return {
        passed: allPassed,
        rootConfigValid,
        rootConfigPath,
        rootErrors,
        configs
    };
}

export function formatValidationReport(report: ConfigValidationReport): string {
    const lines: string[] = [];
    lines.push(report.passed ? 'CONFIG_VALIDATION_PASSED' : 'CONFIG_VALIDATION_FAILED');
    lines.push(`RootConfig: ${report.rootConfigValid ? 'valid' : 'INVALID'} (${report.rootConfigPath})`);
    for (const err of report.rootErrors) {
        lines.push(`  root: ${err}`);
    }

    for (const cfg of report.configs) {
        const status = cfg.exists
            ? (cfg.schemaValid && cfg.runtimeValid ? 'PASS' : 'FAIL')
            : 'MISSING';
        lines.push(`  ${cfg.name}: ${status}`);
        for (const err of cfg.errors) {
            lines.push(`    - ${err}`);
        }
    }

    return lines.join('\n');
}

export function formatValidationReportCompact(report: ConfigValidationReport): string {
    const passCount = report.configs.filter((c) => c.schemaValid && c.runtimeValid).length;
    return `${report.passed ? 'CONFIG_VALIDATION_PASSED' : 'CONFIG_VALIDATION_FAILED'}: ${passCount}/${report.configs.length} configs valid, root=${report.rootConfigValid ? 'ok' : 'INVALID'}, root_errors=${report.rootErrors.length}`;
}

function getManagedValidators(): Record<string, (input: unknown) => Record<string, unknown>> {
    return getManagedConfigValidators() as Record<string, (input: unknown) => Record<string, unknown>>;
}

function getRootConfigMap(rootData: Record<string, unknown>): Record<string, string> {
    const rawConfigs = ensurePlainObject(rootData.configs, 'garda.config.json.configs');
    const map: Record<string, string> = {};

    for (const entry of CONFIG_SCHEMAS) {
        const relativePath = rawConfigs[entry.name];
        if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
            if (OPTIONAL_ROOT_CONFIG_NAMES.has(entry.name)) {
                continue;
            }
            throw new Error(`garda.config.json.configs.${entry.name} must be a non-empty string.`);
        }
        map[entry.name] = relativePath.trim();
    }

    return map;
}

function resolveManifestConfigPath(configDir: string, relativePath: string): string | null {
    const resolvedPath = path.resolve(configDir, relativePath);
    const relativeToConfigDir = path.relative(configDir, resolvedPath);
    if (relativeToConfigDir.startsWith('..') || path.isAbsolute(relativeToConfigDir)) {
        return null;
    }
    return resolvedPath;
}

