import * as path from 'node:path';

export const PRODUCT_NAME = 'Garda Agent Orchestrator';
export const DEFAULT_BUNDLE_NAME = 'garda-agent-orchestrator';
export const PRIMARY_CLI_ENTRYPOINT = path.join('bin', 'garda.js');
export const RECOGNIZED_PACKAGE_NAMES = new Set([
    'garda-agent-orchestrator'
]);

export const SOURCE_CHECKOUT_PROVENANCE_PATHS = Object.freeze([
    path.join('src', 'bin', 'garda.ts'),
    path.join('tests', 'node'),
    path.join('scripts', 'node-foundation')
]);

export const DEPLOYED_BUNDLE_PROVENANCE_PATHS = Object.freeze([
    'MANIFEST.md',
    path.join('live', 'version.json'),
    path.join('live', 'docs', 'agent-rules', '00-core.md'),
    path.join('live', 'config', 'profiles.json'),
    path.join('live', 'config', 'review-capabilities.json')
]);

