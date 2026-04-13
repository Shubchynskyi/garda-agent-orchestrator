import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
    resolveProtectedHashCachePath,
    readProtectedHashCache,
    writeProtectedHashCache,
    getCachedHashIfCurrent,
    hashFileWithCache,
    scanProtectedPathHashesIncremental,
    type ProtectedHashCache,
    type ProtectedHashCacheEntry
} from '../../../src/gates/protected-hash-cache';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'protected-hash-cache-test-'));
}

function removeTempDir(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

function sha256(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
}

describe('gates/protected-hash-cache', () => {

    describe('readProtectedHashCache', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns null for missing file', () => {
            assert.equal(readProtectedHashCache(path.join(tempDir, 'missing.json')), null);
        });

        it('returns null for invalid JSON', () => {
            const p = path.join(tempDir, 'bad.json');
            fs.writeFileSync(p, '{{not-json', 'utf8');
            assert.equal(readProtectedHashCache(p), null);
        });

        it('returns null for incompatible cache_version', () => {
            const p = path.join(tempDir, 'old.json');
            fs.writeFileSync(p, JSON.stringify({ cache_version: 99, entries: {} }), 'utf8');
            assert.equal(readProtectedHashCache(p), null);
        });

        it('returns null when entries is not an object', () => {
            const p = path.join(tempDir, 'array.json');
            fs.writeFileSync(p, JSON.stringify({ cache_version: 1, entries: [] }), 'utf8');
            assert.equal(readProtectedHashCache(p), null);
        });

        it('returns null when an entry has missing fields', () => {
            const p = path.join(tempDir, 'partial.json');
            fs.writeFileSync(p, JSON.stringify({
                cache_version: 1,
                entries: { 'src/foo.ts': { size: 100 } }
            }), 'utf8');
            assert.equal(readProtectedHashCache(p), null);
        });

        it('returns null when an entry has wrong field types', () => {
            const p = path.join(tempDir, 'badtype.json');
            fs.writeFileSync(p, JSON.stringify({
                cache_version: 1,
                entries: { 'src/foo.ts': { size: '100', mtime_ms: 123, sha256: 'abc' } }
            }), 'utf8');
            assert.equal(readProtectedHashCache(p), null);
        });

        it('returns valid cache for correct structure', () => {
            const p = path.join(tempDir, 'ok.json');
            const cache: ProtectedHashCache = {
                cache_version: 1,
                entries: {
                    'src/foo.ts': { size: 100, mtime_ms: 1000, sha256: 'abcdef' }
                }
            };
            fs.writeFileSync(p, JSON.stringify(cache), 'utf8');
            const result = readProtectedHashCache(p);
            assert.ok(result);
            assert.equal(result.cache_version, 1);
            assert.equal(result.entries['src/foo.ts'].sha256, 'abcdef');
        });

        it('returns valid cache with empty entries', () => {
            const p = path.join(tempDir, 'empty.json');
            fs.writeFileSync(p, JSON.stringify({ cache_version: 1, entries: {} }), 'utf8');
            const result = readProtectedHashCache(p);
            assert.ok(result);
            assert.deepStrictEqual(result.entries, {});
        });
    });

    describe('writeProtectedHashCache', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('writes and reads back a cache', () => {
            const p = path.join(tempDir, 'write.json');
            const cache: ProtectedHashCache = {
                cache_version: 1,
                entries: {
                    'src/a.ts': { size: 50, mtime_ms: 2000, sha256: 'deadbeef' }
                }
            };
            writeProtectedHashCache(p, cache);
            const readBack = readProtectedHashCache(p);
            assert.ok(readBack);
            assert.equal(readBack.entries['src/a.ts'].sha256, 'deadbeef');
        });

        it('creates parent directories if needed', () => {
            const deep = path.join(tempDir, 'a', 'b', 'c', 'cache.json');
            writeProtectedHashCache(deep, { cache_version: 1, entries: {} });
            assert.ok(fs.existsSync(deep));
        });

        it('atomic write does not leave tmp file on success', () => {
            const p = path.join(tempDir, 'atomic.json');
            writeProtectedHashCache(p, { cache_version: 1, entries: {} });
            assert.ok(fs.existsSync(p));
            assert.ok(!fs.existsSync(p + '.tmp'));
        });
    });

    describe('getCachedHashIfCurrent', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns cached hash when metadata matches', () => {
            const filePath = path.join(tempDir, 'file.txt');
            fs.writeFileSync(filePath, 'hello world', 'utf8');
            const stat = fs.statSync(filePath);
            const entry: ProtectedHashCacheEntry = {
                size: stat.size,
                mtime_ms: stat.mtimeMs,
                sha256: 'cached-hash-value'
            };
            assert.equal(getCachedHashIfCurrent(entry, filePath), 'cached-hash-value');
        });

        it('returns null when size differs', () => {
            const filePath = path.join(tempDir, 'file.txt');
            fs.writeFileSync(filePath, 'hello', 'utf8');
            const stat = fs.statSync(filePath);
            const entry: ProtectedHashCacheEntry = {
                size: stat.size + 100,
                mtime_ms: stat.mtimeMs,
                sha256: 'stale'
            };
            assert.equal(getCachedHashIfCurrent(entry, filePath), null);
        });

        it('returns null when mtime differs', () => {
            const filePath = path.join(tempDir, 'file.txt');
            fs.writeFileSync(filePath, 'hello', 'utf8');
            const stat = fs.statSync(filePath);
            const entry: ProtectedHashCacheEntry = {
                size: stat.size,
                mtime_ms: stat.mtimeMs + 5000,
                sha256: 'stale'
            };
            assert.equal(getCachedHashIfCurrent(entry, filePath), null);
        });

        it('returns null when file does not exist', () => {
            const entry: ProtectedHashCacheEntry = {
                size: 10,
                mtime_ms: 1000,
                sha256: 'ghost'
            };
            assert.equal(getCachedHashIfCurrent(entry, path.join(tempDir, 'gone.txt')), null);
        });

        it('returns null for a directory path', () => {
            const dirPath = path.join(tempDir, 'subdir');
            fs.mkdirSync(dirPath);
            const entry: ProtectedHashCacheEntry = {
                size: 0,
                mtime_ms: 0,
                sha256: 'dir'
            };
            assert.equal(getCachedHashIfCurrent(entry, dirPath), null);
        });
    });

    describe('hashFileWithCache', () => {
        let tempDir: string;
        beforeEach(() => { tempDir = createTempDir(); });
        afterEach(() => { removeTempDir(tempDir); });

        it('returns cached hash on cache hit and does not update entry', () => {
            const filePath = path.join(tempDir, 'cached.txt');
            fs.writeFileSync(filePath, 'cached content', 'utf8');
            const stat = fs.statSync(filePath);
            const cache: ProtectedHashCache = {
                cache_version: 1,
                entries: {
                    'cached.txt': {
                        size: stat.size,
                        mtime_ms: stat.mtimeMs,
                        sha256: 'previously-computed-hash'
                    }
                }
            };
            const result = hashFileWithCache(filePath, 'cached.txt', cache);
            assert.equal(result, 'previously-computed-hash');
        });

        it('computes hash on cache miss and updates cache entry', () => {
            const filePath = path.join(tempDir, 'miss.txt');
            const content = 'new content for hashing';
            fs.writeFileSync(filePath, content, 'utf8');
            const cache: ProtectedHashCache = { cache_version: 1, entries: {} };

            const result = hashFileWithCache(filePath, 'miss.txt', cache);

            const expected = sha256(Buffer.from(content, 'utf8'));
            assert.equal(result, expected);
            assert.ok(cache.entries['miss.txt']);
            assert.equal(cache.entries['miss.txt'].sha256, expected);
        });

        it('recomputes hash when file is modified', () => {
            const filePath = path.join(tempDir, 'modified.txt');
            fs.writeFileSync(filePath, 'original', 'utf8');

            const cache: ProtectedHashCache = {
                cache_version: 1,
                entries: {
                    'modified.txt': {
                        size: 999,
                        mtime_ms: 0,
                        sha256: 'old-hash'
                    }
                }
            };

            const result = hashFileWithCache(filePath, 'modified.txt', cache);
            const expected = sha256(Buffer.from('original', 'utf8'));
            assert.equal(result, expected);
            assert.equal(cache.entries['modified.txt'].sha256, expected);
        });

        it('returns <error> for non-existent file', () => {
            const cache: ProtectedHashCache = { cache_version: 1, entries: {} };
            const result = hashFileWithCache(
                path.join(tempDir, 'gone.txt'),
                'gone.txt',
                cache
            );
            assert.equal(result, '<error>');
        });
    });

    describe('scanProtectedPathHashesIncremental', () => {
        let tempDir: string;
        beforeEach(() => {
            tempDir = createTempDir();
            // Create a minimal bundle-like structure so joinOrchestratorPath resolves
            const bundleDir = path.join(tempDir, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(bundleDir, 'runtime'), { recursive: true });
            fs.writeFileSync(path.join(bundleDir, 'VERSION'), '1.0.0', 'utf8');
            fs.writeFileSync(path.join(bundleDir, 'MANIFEST.md'), '# Manifest', 'utf8');
        });
        afterEach(() => { removeTempDir(tempDir); });

        it('scans all files under protected roots', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'a.ts'), 'const a = 1;', 'utf8');
            fs.writeFileSync(path.join(srcDir, 'b.ts'), 'const b = 2;', 'utf8');

            const result = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.ok(result['src/gates/a.ts']);
            assert.ok(result['src/gates/b.ts']);
            assert.equal(result['src/gates/a.ts'], sha256(Buffer.from('const a = 1;', 'utf8')));
        });

        it('creates a cache file after first scan', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'x.ts'), 'x', 'utf8');

            scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);

            const cachePath = resolveProtectedHashCachePath(tempDir);
            assert.ok(fs.existsSync(cachePath), 'Cache file should be created after scan');
            const cache = readProtectedHashCache(cachePath);
            assert.ok(cache);
            assert.ok(cache.entries['src/gates/x.ts']);
        });

        it('reuses cached hashes on second scan when files are unchanged', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'stable.ts'), 'stable content', 'utf8');

            // First scan — populates cache
            const r1 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            const cachePath = resolveProtectedHashCachePath(tempDir);
            const cacheAfterFirst = readProtectedHashCache(cachePath);
            assert.ok(cacheAfterFirst);

            // Second scan — should use cache (results must be identical)
            const r2 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.deepStrictEqual(r1, r2);
        });

        it('detects file modification and recomputes hash', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            const filePath = path.join(srcDir, 'changing.ts');
            fs.writeFileSync(filePath, 'version1', 'utf8');

            const r1 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            const hash1 = r1['src/gates/changing.ts'];

            // Modify the file
            fs.writeFileSync(filePath, 'version2', 'utf8');
            const futureTime = new Date(Date.now() + 60000);
            fs.utimesSync(filePath, futureTime, futureTime);

            const r2 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            const hash2 = r2['src/gates/changing.ts'];

            assert.notEqual(hash1, hash2);
            assert.equal(hash2, sha256(Buffer.from('version2', 'utf8')));
        });

        it('handles new files added between scans', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'original.ts'), 'original', 'utf8');

            const r1 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.equal(Object.keys(r1).length, 1);

            // Add a new file
            fs.writeFileSync(path.join(srcDir, 'added.ts'), 'added', 'utf8');

            const r2 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.equal(Object.keys(r2).length, 2);
            assert.ok(r2['src/gates/added.ts']);
        });

        it('handles deleted files between scans', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'keep.ts'), 'keep', 'utf8');
            fs.writeFileSync(path.join(srcDir, 'delete-me.ts'), 'bye', 'utf8');

            const r1 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.equal(Object.keys(r1).length, 2);

            // Delete one file
            fs.unlinkSync(path.join(srcDir, 'delete-me.ts'));

            const r2 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.equal(Object.keys(r2).length, 1);
            assert.ok(r2['src/gates/keep.ts']);
            assert.ok(!r2['src/gates/delete-me.ts']);

            // Cache should be pruned too
            const cachePath = resolveProtectedHashCachePath(tempDir);
            const cache = readProtectedHashCache(cachePath);
            assert.ok(cache);
            assert.ok(!cache.entries['src/gates/delete-me.ts']);
        });

        it('tolerates corrupted cache and falls back to full scan', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'file.ts'), 'content', 'utf8');

            // Write garbage to cache
            const cachePath = resolveProtectedHashCachePath(tempDir);
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, '{{{{corrupted!!!!', 'utf8');

            // Scan should still succeed
            const result = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.ok(result['src/gates/file.ts']);
            assert.equal(result['src/gates/file.ts'], sha256(Buffer.from('content', 'utf8')));
        });

        it('tolerates missing cache file gracefully', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'file.ts'), 'data', 'utf8');

            const result = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.ok(result['src/gates/file.ts']);
        });

        it('skips non-existent protected roots', () => {
            const result = scanProtectedPathHashesIncremental(tempDir, ['nonexistent/path/']);
            assert.deepStrictEqual(result, {});
        });

        it('handles single-file protected roots', () => {
            const filePath = path.join(tempDir, 'single-file.ts');
            fs.writeFileSync(filePath, 'solo', 'utf8');

            const result = scanProtectedPathHashesIncremental(tempDir, ['single-file.ts']);
            assert.ok(result['single-file.ts']);
            assert.equal(result['single-file.ts'], sha256(Buffer.from('solo', 'utf8')));
        });

        it('produces identical results to a fresh full scan', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'a.ts'), 'aaa', 'utf8');
            fs.writeFileSync(path.join(srcDir, 'b.ts'), 'bbb', 'utf8');

            // First scan creates cache
            scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);

            // Modify one file, add another, delete one
            fs.writeFileSync(path.join(srcDir, 'a.ts'), 'aaa-modified', 'utf8');
            fs.writeFileSync(path.join(srcDir, 'c.ts'), 'ccc', 'utf8');
            fs.unlinkSync(path.join(srcDir, 'b.ts'));

            // Second scan should reflect all changes accurately
            const r2 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.equal(r2['src/gates/a.ts'], sha256(Buffer.from('aaa-modified', 'utf8')));
            assert.equal(r2['src/gates/c.ts'], sha256(Buffer.from('ccc', 'utf8')));
            assert.ok(!r2['src/gates/b.ts']);
        });

        it('proves cache hit avoids file re-read by checking cache file is not rewritten for unchanged set', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'stable.ts'), 'immutable content', 'utf8');

            // First scan
            scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            // Brief wait for mtime resolution
            const start = Date.now();
            while (Date.now() - start < 50) { /* busy wait */ }

            // Second scan with no file changes (readOnly=false, the default) —
            // cache gets rewritten but the content/hashes should be identical
            const r2 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.ok(r2['src/gates/stable.ts']);
            assert.equal(r2['src/gates/stable.ts'], sha256(Buffer.from('immutable content', 'utf8')));
        });

        it('handles version-incompatible cache by starting fresh', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'v.ts'), 'versioned', 'utf8');

            // Write cache with future version
            const cachePath = resolveProtectedHashCachePath(tempDir);
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, JSON.stringify({
                cache_version: 999,
                entries: { 'src/gates/v.ts': { size: 9, mtime_ms: 0, sha256: 'bogus' } }
            }), 'utf8');

            const result = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.equal(result['src/gates/v.ts'], sha256(Buffer.from('versioned', 'utf8')));
        });

        it('empty protected roots produce empty result', () => {
            const result = scanProtectedPathHashesIncremental(tempDir, []);
            assert.deepStrictEqual(result, {});
        });

        it('handles nested directory structures', () => {
            const deepDir = path.join(tempDir, 'src', 'gates', 'sub', 'deep');
            fs.mkdirSync(deepDir, { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'src', 'gates', 'top.ts'), 'top', 'utf8');
            fs.writeFileSync(path.join(deepDir, 'nested.ts'), 'nested', 'utf8');

            const result = scanProtectedPathHashesIncremental(tempDir, ['src/gates/']);
            assert.ok(result['src/gates/top.ts']);
            assert.ok(result['src/gates/sub/deep/nested.ts']);
        });

        it('readOnly=true does not write a cache file', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'readonly.ts'), 'readonly content', 'utf8');

            const result = scanProtectedPathHashesIncremental(tempDir, ['src/gates/'], true);
            assert.ok(result['src/gates/readonly.ts']);
            assert.equal(result['src/gates/readonly.ts'], sha256(Buffer.from('readonly content', 'utf8')));

            const cachePath = resolveProtectedHashCachePath(tempDir);
            assert.ok(!fs.existsSync(cachePath), 'Cache file must not be created in readOnly mode');
        });

        it('readOnly=true still uses existing cache for reads', () => {
            const srcDir = path.join(tempDir, 'src', 'gates');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'cached.ts'), 'cached content', 'utf8');

            // First scan with readOnly=false to populate cache
            scanProtectedPathHashesIncremental(tempDir, ['src/gates/'], false);
            const cachePath = resolveProtectedHashCachePath(tempDir);
            assert.ok(fs.existsSync(cachePath));
            const cacheMtimeBefore = fs.statSync(cachePath).mtimeMs;

            // Brief wait for mtime resolution
            const start = Date.now();
            while (Date.now() - start < 50) { /* busy wait */ }

            // Second scan with readOnly=true should not rewrite the cache
            const r2 = scanProtectedPathHashesIncremental(tempDir, ['src/gates/'], true);
            assert.equal(r2['src/gates/cached.ts'], sha256(Buffer.from('cached content', 'utf8')));

            const cacheMtimeAfter = fs.statSync(cachePath).mtimeMs;
            assert.equal(cacheMtimeAfter, cacheMtimeBefore, 'Cache file should not be rewritten in readOnly mode');
        });
    });
});
