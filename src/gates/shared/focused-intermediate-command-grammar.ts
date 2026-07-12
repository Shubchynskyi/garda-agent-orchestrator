import * as path from 'node:path';

function basenameLower(token: string): string {
    return path.basename(token).toLowerCase();
}

function isBareCommandToken(token: string): boolean {
    return token === path.basename(token) && !token.includes('/') && !token.includes('\\');
}

function isNodeToken(token: string): boolean {
    return isBareCommandToken(token) && ['node', 'node.exe'].includes(basenameLower(token));
}

function isNpmToken(token: string): boolean {
    return isBareCommandToken(token) && ['npm', 'npm.cmd', 'npm.exe'].includes(basenameLower(token));
}

function normalizeCommandPathToken(token: string): string {
    return token.replace(/\\/g, '/').replace(/^\.\//u, '');
}

function isSafeFocusedTestPath(token: string): boolean {
    const normalizedPath = normalizeCommandPathToken(token);
    return normalizedPath.startsWith('tests/')
        && !normalizedPath.split('/').includes('..')
        && /\.(?:test|spec)\.(?:c|m)?[jt]sx?$/u.test(normalizedPath);
}

function isNodeFoundationFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    return isNodeToken(binary)
        && normalizeCommandPathToken(args[0] ?? '') === 'scripts/node-foundation/build-scripts.cjs'
        && args[1] === 'test.js'
        && args.length >= 3
        && args.slice(2).every(isSafeFocusedTestPath);
}

function isNodeTestFocusedCommand(binary: string, args: readonly string[]): boolean {
    return isNodeToken(binary)
        && args[0] === '--test'
        && args.length >= 2
        && args.slice(1).every(isSafeFocusedTestPath);
}

function isNpmFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    return isNpmToken(binary)
        && args[0] === 'test'
        && args[1] === '--'
        && args.length >= 3
        && args.slice(2).every(isSafeFocusedTestPath);
}

export function isFocusedIntermediateCommand(commandSource: string, tokens: readonly string[]): boolean {
    const [binary, ...args] = tokens;
    if (!binary) {
        return false;
    }
    if (commandSource === 'node-test') {
        return isNodeTestFocusedCommand(binary, args);
    }
    if (commandSource === 'targeted-test') {
        return isNpmFocusedTestCommand(binary, args) || isNodeFoundationFocusedTestCommand(binary, args);
    }
    return false;
}
