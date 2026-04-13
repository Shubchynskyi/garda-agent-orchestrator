import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import { formatManifestResult, formatManifestResultCompact, validateManifest } from '../../validators/validate-manifest';
import { validateAllConfigs, formatValidationReport, formatValidationReportCompact } from '../../schemas/config-schemas';
import {
    parseOptions
} from './cli-helpers';
import {
    type ParsedOptionsRecord,
    ValidationFailureError
} from './shared-command-utils';

export async function handleValidateManifest(gateArgv: string[]): Promise<void> {
    const defs = {
        '--manifest-path': { key: 'manifestPath', type: 'string' },
        '--compact': { key: 'compact', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const options = rawOptions as ParsedOptionsRecord;
    const manifestPath = typeof options.manifestPath === 'string'
        ? options.manifestPath
        : path.join(resolveBundleName(), 'MANIFEST.md');
    const result = validateManifest(manifestPath);
    console.log(options.compact === true ? formatManifestResultCompact(result) : formatManifestResult(result));
    if (!result.passed) {
        throw new ValidationFailureError('Manifest validation failed.');
    }
}

export async function handleValidateConfig(gateArgv: string[]): Promise<void> {
    const defs = {
        '--bundle-root': { key: 'bundleRoot', type: 'string' },
        '--compact': { key: 'compact', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs);
    const vcOptions = rawOptions as ParsedOptionsRecord;
    const bundleRoot = typeof vcOptions.bundleRoot === 'string'
        ? path.resolve(vcOptions.bundleRoot)
        : path.resolve(resolveBundleName());
    const vcReport = validateAllConfigs(bundleRoot);
    console.log(vcOptions.compact === true
        ? formatValidationReportCompact(vcReport)
        : formatValidationReport(vcReport));
    if (!vcReport.passed) {
        throw new ValidationFailureError('Config validation failed.');
    }
}
