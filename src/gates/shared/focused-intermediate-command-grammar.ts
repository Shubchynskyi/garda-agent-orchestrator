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

function isBareToolToken(token: string, names: readonly string[]): boolean {
    return isBareCommandToken(token) && names.includes(basenameLower(token));
}

function isRepositoryToolToken(token: string, names: readonly string[]): boolean {
    const normalized = normalizeCommandPathToken(token).toLowerCase();
    return !normalized.split('/').includes('..')
        && names.includes(normalized);
}

function normalizeCommandPathToken(token: string): string {
    return token.replace(/\\/g, '/').replace(/^\.\//u, '');
}

export function isSafeFocusedTestPath(token: string): boolean {
    const normalizedPath = normalizeCommandPathToken(token);
    if (
        !normalizedPath
        || path.isAbsolute(token)
        || normalizedPath.split('/').includes('..')
    ) {
        return false;
    }
    const basename = path.posix.basename(normalizedPath);
    const inTestTree = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)/iu.test(normalizedPath)
        || /(?:^|\/)src\/test\/(?:java|kotlin)(?:\/|$)/iu.test(normalizedPath);
    return /\.(?:test|spec)\.(?:c|m)?[jt]sx?$/iu.test(normalizedPath)
        || ((inTestTree || /^(?:test_.+|.+_test)\.py$/iu.test(basename)) && /\.py$/iu.test(basename))
        || ((inTestTree || /(?:Test|Tests)\.(?:java|kt)$/u.test(basename)) && /\.(?:java|kt)$/iu.test(basename))
        || /_test\.go$/iu.test(basename)
        || ((inTestTree || /(?:_test|_spec)\.rb$/iu.test(basename)) && /\.rb$/iu.test(basename))
        || ((inTestTree || /Test\.php$/u.test(basename)) && /\.php$/iu.test(basename))
        || (inTestTree && /\.rs$/iu.test(basename))
        || ((inTestTree || /Tests?\.cs$/u.test(basename)) && /\.cs$/iu.test(basename));
}

export function getJvmFocusedTestSelector(testPath: string): string | null {
    const normalized = normalizeCommandPathToken(testPath);
    const match = normalized.match(/(?:^|\/)src\/test\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/iu);
    return match?.[1]?.replace(/\//g, '.') || null;
}

export function getGoFocusedPackageTarget(testPath: string): string | null {
    const normalized = normalizeCommandPathToken(testPath);
    if (!/_test\.go$/iu.test(path.posix.basename(normalized))) {
        return null;
    }
    const directory = path.posix.dirname(normalized);
    return directory === '.' ? '.' : `./${directory}`;
}

export function getRustFocusedIntegrationTarget(testPath: string): string | null {
    const normalized = normalizeCommandPathToken(testPath);
    const match = normalized.match(/(?:^|\/)tests\/([^/]+)\.rs$/iu);
    return match?.[1] || null;
}

export function getDotnetFocusedClassTarget(testPath: string): string | null {
    const normalized = normalizeCommandPathToken(testPath);
    const basename = path.posix.basename(normalized);
    return /Tests?\.cs$/u.test(basename) ? basename.replace(/\.cs$/iu, '') : null;
}

export function getFocusedTestPathsFromCommandTokens(tokens: readonly string[]): string[] {
    return [...new Set(
        tokens
            .map(normalizeCommandPathToken)
            .filter(isSafeFocusedTestPath)
    )].sort();
}

export function getChangedTestPathsTargetedByCommandTokens(
    tokens: readonly string[],
    candidatePaths: readonly string[]
): string[] {
    const candidates = [...new Set(candidatePaths
        .map(normalizeCommandPathToken)
        .filter(isSafeFocusedTestPath))];
    const directTargets = new Set(getFocusedTestPathsFromCommandTokens(tokens));
    const matched = new Set(candidates.filter((candidate) => directTargets.has(candidate)));

    const mavenSelector = tokens.find((token) => /^-Dtest=[A-Za-z_$][A-Za-z0-9_$.]*$/u.test(token))
        ?.slice('-Dtest='.length);
    const gradleSelectorIndex = tokens.indexOf('--tests');
    const gradleSelector = gradleSelectorIndex >= 0 ? tokens[gradleSelectorIndex + 1] : undefined;
    const jvmSelector = mavenSelector || gradleSelector;
    if (jvmSelector) {
        candidates
            .filter((candidate) => getJvmFocusedTestSelector(candidate) === jvmSelector)
            .forEach((candidate) => matched.add(candidate));
    }

    if (isBareToolToken(tokens[0] ?? '', ['go', 'go.exe']) && tokens[1] === 'test') {
        const packageTarget = tokens[2];
        candidates
            .filter((candidate) => getGoFocusedPackageTarget(candidate) === packageTarget)
            .forEach((candidate) => matched.add(candidate));
    }

    if (isBareToolToken(tokens[0] ?? '', ['cargo', 'cargo.exe']) && tokens[1] === 'test') {
        const targetIndex = tokens.indexOf('--test');
        const integrationTarget = targetIndex >= 0 ? tokens[targetIndex + 1] : undefined;
        candidates
            .filter((candidate) => getRustFocusedIntegrationTarget(candidate) === integrationTarget)
            .forEach((candidate) => matched.add(candidate));
    }

    if (isBareToolToken(tokens[0] ?? '', ['dotnet', 'dotnet.exe']) && tokens[1] === 'test') {
        const filterIndex = tokens.indexOf('--filter');
        const filter = filterIndex >= 0 ? tokens[filterIndex + 1] : undefined;
        const classTarget = filter?.match(/^FullyQualifiedName~([A-Za-z_][A-Za-z0-9_.+]*)$/u)?.[1];
        candidates
            .filter((candidate) => getDotnetFocusedClassTarget(candidate) === classTarget)
            .forEach((candidate) => matched.add(candidate));
    }

    return [...matched].sort();
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

function isPythonFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    const directPytest = isBareToolToken(binary, ['pytest', 'pytest.exe'])
        && args.length >= 1
        && args.every((argument) => isSafeFocusedTestPath(argument) && /\.py$/iu.test(argument));
    return directPytest || (
        isBareToolToken(binary, ['python', 'python.exe', 'python3', 'python3.exe'])
        && args[0] === '-m'
        && args[1] === 'pytest'
        && args.length >= 3
        && args.slice(2).every((argument) => isSafeFocusedTestPath(argument) && /\.py$/iu.test(argument))
    );
}

function isJvmFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    const safeSelector = '[A-Za-z_$][A-Za-z0-9_$.]*';
    const maven = isRepositoryToolToken(binary, ['mvn', 'mvn.cmd', 'mvn.exe', 'mvnw', 'mvnw.cmd'])
        && args.length === 3
        && args[0] === '-q'
        && new RegExp(`^-Dtest=${safeSelector}$`, 'u').test(args[1] ?? '')
        && args[2] === 'test';
    const gradle = isRepositoryToolToken(binary, ['gradle', 'gradle.bat', 'gradle.exe', 'gradlew', 'gradlew.bat'])
        && args.length === 4
        && args[0] === 'test'
        && args[1] === '--tests'
        && new RegExp(`^${safeSelector}$`, 'u').test(args[2] ?? '')
        && args[3] === '--console=plain';
    return maven || gradle;
}

function isGoFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    const target = args[1] ?? '';
    return isBareToolToken(binary, ['go', 'go.exe'])
        && args.length === 2
        && args[0] === 'test'
        && (target === '.' || /^\.\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(target));
}

function isRustFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    return isBareToolToken(binary, ['cargo', 'cargo.exe'])
        && args.length === 3
        && args[0] === 'test'
        && args[1] === '--test'
        && /^[A-Za-z0-9_-]+$/u.test(args[2] ?? '');
}

function isDotnetFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    return isBareToolToken(binary, ['dotnet', 'dotnet.exe'])
        && args.length === 5
        && args[0] === 'test'
        && args[1] === '--filter'
        && /^FullyQualifiedName~[A-Za-z_][A-Za-z0-9_.+]*$/u.test(args[2] ?? '')
        && args[3] === '--verbosity'
        && args[4] === 'quiet';
}

function isRubyFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    const directRuby = isBareToolToken(binary, ['ruby', 'ruby.exe'])
        && args.length === 1
        && isSafeFocusedTestPath(args[0] ?? '')
        && /\.rb$/iu.test(args[0] ?? '');
    return directRuby || (
        isBareToolToken(binary, ['bundle', 'bundle.cmd', 'bundle.exe'])
        && args.length === 3
        && args[0] === 'exec'
        && args[1] === 'rspec'
        && isSafeFocusedTestPath(args[2] ?? '')
        && /\.rb$/iu.test(args[2] ?? '')
    );
}

function isPhpFocusedTestCommand(binary: string, args: readonly string[]): boolean {
    return isRepositoryToolToken(binary, ['phpunit', 'phpunit.bat', 'phpunit.exe', 'vendor/bin/phpunit'])
        && args.length === 1
        && isSafeFocusedTestPath(args[0] ?? '')
        && /\.php$/iu.test(args[0] ?? '');
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
        return isNpmFocusedTestCommand(binary, args)
            || isNodeFoundationFocusedTestCommand(binary, args)
            || isPythonFocusedTestCommand(binary, args)
            || isJvmFocusedTestCommand(binary, args)
            || isGoFocusedTestCommand(binary, args)
            || isRustFocusedTestCommand(binary, args)
            || isDotnetFocusedTestCommand(binary, args)
            || isRubyFocusedTestCommand(binary, args)
            || isPhpFocusedTestCommand(binary, args);
    }
    return false;
}
