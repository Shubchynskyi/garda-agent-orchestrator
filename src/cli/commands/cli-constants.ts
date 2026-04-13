export const DEFAULT_REPO_URL = 'https://github.com/Shubchynskyi/garda-agent-orchestrator.git';

export const SKIPPED_ENTRY_NAMES = new Set([
    '__pycache__',
    '.pytest_cache'
]);

export const SKIPPED_FILE_SUFFIXES = Object.freeze([
    '.pyc',
    '.pyo',
    '.pyd'
]);

export const DEPLOY_ITEMS = Object.freeze([
    '.gitattributes',
    'bin',
    'src',
    'template',
    'AGENT_INIT_PROMPT.md',
    'CHANGELOG.md',
    'HOW_TO.md',
    'LICENSE',
    'MANIFEST.md',
    'README.md',
    'VERSION',
    'package.json'
]);

export const COMPILED_RUNTIME_DEPLOY_CANDIDATES = Object.freeze([
    'dist',
    '.node-build'
]);

export const COMMAND_SUMMARY = Object.freeze([
    ['setup', 'First-run onboarding'],
    ['agent-init', 'Finalize mandatory agent onboarding'],
    ['status', 'Show workspace status'],
    ['doctor', 'Run verify + manifest validation'],
    ['debug env', 'Show environment triage snapshot'],
    ['stats', 'Token-overhead and runtime analytics'],
    ['bootstrap', 'Deploy bundle only'],
    ['reinit', 'Change init answers'],
    ['update', 'Check/apply updates'],
    ['update git', 'Apply update from git source'],
    ['rollback', 'Rollback to a specific or previous version'],
    ['uninstall', 'Remove orchestrator'],
    ['verify', 'Verify workspace layout'],
    ['check-update', 'Check for available updates'],
    ['skills', 'List, suggest, and manage optional skill packs'],
    ['profile', 'List, use, create, delete, and validate workspace profiles'],
    ['diff-managed', 'Show managed vs user-owned block ownership'],
    ['gate', 'Run an agent gate (gate <name>)']
]);
