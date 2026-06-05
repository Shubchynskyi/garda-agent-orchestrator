import * as fs from 'node:fs';
import * as path from 'node:path';

import { matchAnyRegex } from '../../gate-runtime/text-utils';
import { normalizePath } from '../shared/helpers';

const WEAK_DB_SIGNAL_REGEXES = Object.freeze([
    '(Repository|Dao|Specification|Query|Migration)[^/]*\\.(java|kt|ts|js|py|go|cs|rb|php)$'
]);

const DB_PROJECT_EVIDENCE_PATHS = Object.freeze([
    'db',
    'database',
    'migrations',
    'prisma/schema.prisma',
    'src/db',
    'src/database',
    'src/migrations',
    'src/main/resources/db',
    'src/main/resources/database',
    'src/main/resources/migrations',
    'knexfile.js',
    'knexfile.ts',
    'ormconfig.js',
    'ormconfig.ts',
    'ormconfig.json',
    'sequelize.config.js',
    'sequelize.config.ts',
    'liquibase.properties',
    'flyway.conf',
    'alembic.ini'
]);

const DB_PACKAGE_NAMES = Object.freeze([
    '@prisma/client',
    'prisma',
    'typeorm',
    'knex',
    'sequelize',
    'mongoose',
    'mongodb',
    'pg',
    'mysql',
    'mysql2',
    'sqlite3',
    'better-sqlite3',
    'mariadb',
    'mssql'
]);

const DB_MANIFEST_MARKERS = Object.freeze([
    'alembic',
    'database',
    'diesel',
    'flyway',
    'gorm',
    'hibernate',
    'jdbc',
    'jooq',
    'jpa',
    'knex',
    'liquibase',
    'mongodb',
    'mongoose',
    'mybatis',
    'mysql',
    'postgres',
    'postgresql',
    'prisma',
    'psycopg',
    'r2dbc',
    'sequelize',
    'sqlalchemy',
    'sqlite',
    'spring-boot-starter-data-jpa',
    'typeorm'
]);

const DB_MANIFEST_FILES = Object.freeze([
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'requirements.txt',
    'requirements-dev.txt',
    'pyproject.toml',
    'poetry.lock',
    'go.mod',
    'Cargo.toml',
    'composer.json',
    'Gemfile',
    'Gemfile.lock'
]);

const DB_MANIFEST_MAX_BYTES = 512 * 1024;

function readPackageJsonDatabaseEvidence(repoRoot: string): string[] {
    const packageJsonPath = path.join(repoRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return [];
    }

    try {
        const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
        const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        const packageNames = new Set<string>();
        for (const sectionName of dependencySections) {
            const section = raw[sectionName];
            if (!section || typeof section !== 'object') {
                continue;
            }
            for (const packageName of Object.keys(section as Record<string, unknown>)) {
                packageNames.add(packageName.toLowerCase());
            }
        }
        return DB_PACKAGE_NAMES
            .filter((packageName) => packageNames.has(packageName.toLowerCase()))
            .map((packageName) => `package:${packageName}`);
    } catch {
        return [];
    }
}

function readManifestDatabaseEvidence(rootPath: string, relativeRoot: string, manifestFile: string): string[] {
    const manifestPath = path.join(rootPath, manifestFile);
    if (!fs.existsSync(manifestPath)) {
        return [];
    }

    try {
        const stat = fs.statSync(manifestPath);
        if (!stat.isFile() || stat.size > DB_MANIFEST_MAX_BYTES) {
            return [];
        }
        const content = fs.readFileSync(manifestPath, 'utf8').toLowerCase();
        const matchedMarkers = DB_MANIFEST_MARKERS.filter((marker) => content.includes(marker));
        if (matchedMarkers.length === 0) {
            return [];
        }
        const evidencePath = normalizePath(relativeRoot ? `${relativeRoot}/${manifestFile}` : manifestFile);
        return matchedMarkers.map((marker) => `${evidencePath}:${marker}`);
    } catch {
        return [];
    }
}

function collectCandidateDatabaseEvidenceRoots(normalizedFiles: string[]): string[] {
    const roots = new Set<string>(['']);
    for (const filePath of normalizedFiles) {
        const normalizedPath = normalizePath(filePath);
        const parts = normalizedPath.split('/').filter(Boolean);
        parts.pop();
        for (let index = 1; index <= parts.length; index++) {
            roots.add(parts.slice(0, index).join('/'));
        }
    }
    return [...roots].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

export function collectDatabaseProjectEvidence(repoRoot?: string, normalizedFiles: string[] = []): string[] {
    if (!repoRoot) {
        return [];
    }

    const evidence = new Set<string>();
    for (const relativeRoot of collectCandidateDatabaseEvidenceRoots(normalizedFiles)) {
        const rootPath = path.join(repoRoot, relativeRoot);
        if (!fs.existsSync(rootPath)) {
            continue;
        }
        for (const relativePath of DB_PROJECT_EVIDENCE_PATHS) {
            const evidencePath = relativeRoot ? `${relativeRoot}/${relativePath}` : relativePath;
            if (fs.existsSync(path.join(rootPath, relativePath))) {
                evidence.add(normalizePath(evidencePath));
            }
        }
        for (const dependencyEvidence of readPackageJsonDatabaseEvidence(rootPath)) {
            evidence.add(relativeRoot ? `${relativeRoot}/${dependencyEvidence}` : dependencyEvidence);
        }
        for (const manifestFile of DB_MANIFEST_FILES) {
            for (const manifestEvidence of readManifestDatabaseEvidence(rootPath, relativeRoot, manifestFile)) {
                evidence.add(manifestEvidence);
            }
        }
    }
    return [...evidence].sort();
}

export function isConfiguredWeakDatabaseSignal(pathValue: string, dbTriggerRegexes: string[]): boolean {
    const configuredWeakRegexes = dbTriggerRegexes.filter((regex) => WEAK_DB_SIGNAL_REGEXES.includes(regex));
    return configuredWeakRegexes.length > 0 && matchAnyRegex(normalizePath(pathValue), configuredWeakRegexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

export function isStrongDatabaseChangedScope(pathValue: string, sqlOrMigrationRegexes: string[], dbTriggerRegexes: string[]): boolean {
    const normalizedPath = normalizePath(pathValue);
    const configuredStrongRegexes = dbTriggerRegexes.filter((regex) => !WEAK_DB_SIGNAL_REGEXES.includes(regex));
    const strongRegexes = configuredStrongRegexes.filter((regex) => sqlOrMigrationRegexes.includes(regex) || dbTriggerRegexes.includes(regex));
    return matchAnyRegex(normalizedPath, strongRegexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}
