import { describe, it } from 'node:test';
import {
    assert,
    fs,
    os,
    path,
    getRulePack,
    toNonNegativeInt,
    resolveContextOutputPath,
    resolveScopedDiffMetadataPath,
    getCanonicalReviewContextPath,
    getLegacyDefaultReviewContextPath,
    resolveCanonicalReviewContextPath} from './build-review-context-fixtures';

describe('gates/build-review-context core contracts', () => {
    describe('getRulePack', () => {
        it('keeps code reviewers on generated handoff instructions only', () => {
            const pack = getRulePack('code');
            assert.deepEqual(pack, { full: [], depth1: [], depth2: [] });
        });

        it('keeps db/security reviewers on generated handoff instructions only', () => {
            const pack = getRulePack('db');
            const secPack = getRulePack('security');
            assert.deepEqual(pack, secPack);
            assert.deepEqual(pack, { full: [], depth1: [], depth2: [] });
        });

        it('keeps refactor reviewers on generated handoff instructions only', () => {
            const pack = getRulePack('refactor');
            assert.deepEqual(pack, { full: [], depth1: [], depth2: [] });
        });

        it('keeps custom reviewers on generated handoff instructions only', () => {
            const pack = getRulePack('unknown');
            assert.deepEqual(pack, { full: [], depth1: [], depth2: [] });
        });

        it('depth1 is always a subset of full', () => {
            for (const type of ['code', 'db', 'security', 'refactor']) {
                const pack = getRulePack(type);
                for (const file of pack.depth1) {
                    assert.ok(pack.full.includes(file), `depth1 file ${file} not in full for ${type}`);
                }
            }
        });

        it('keeps all repository rule files out of every reviewer pack', () => {
            for (const type of ['code', 'db', 'security', 'refactor', 'unknown']) {
                const pack = getRulePack(type);
                for (const selected of [pack.full, pack.depth1, pack.depth2]) {
                    assert.deepEqual(selected, [], type);
                }
            }
        });
    });

    describe('toNonNegativeInt', () => {
        it('returns int for positive number', () => {
            assert.equal(toNonNegativeInt(42), 42);
        });
        it('returns int for string number', () => {
            assert.equal(toNonNegativeInt('50'), 50);
        });
        it('returns null for boolean', () => {
            assert.equal(toNonNegativeInt(true), null);
        });
        it('returns null for null', () => {
            assert.equal(toNonNegativeInt(null), null);
        });
        it('returns null for negative', () => {
            assert.equal(toNonNegativeInt(-1), null);
        });
        it('returns 0 for zero', () => {
            assert.equal(toNonNegativeInt(0), 0);
        });
    });

    describe('resolveContextOutputPath', () => {
        it('derives from preflight path when explicit is empty', () => {
            const result = resolveContextOutputPath('', '/repo/reviews/T-001-preflight.json', 'code', '/repo');
            assert.ok(result!.includes('T-001-code-review-context.json'));
        });
    });

    describe('resolveScopedDiffMetadataPath', () => {
        it('derives from preflight path when explicit is empty', () => {
            const result = resolveScopedDiffMetadataPath('', '/repo/reviews/T-001-preflight.json', 'db', '/repo');
            assert.ok(result!.includes('T-001-db-scoped.json'));
        });
    });

    describe('resolveCanonicalReviewContextPath', () => {
        it('materializes canonical default path from legacy default artifact when needed', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-paths-'));
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });

            const canonicalPath = getCanonicalReviewContextPath(reviewsRoot, 'T-001', 'code');
            const legacyPath = getLegacyDefaultReviewContextPath(reviewsRoot, 'T-001', 'code');
            fs.writeFileSync(legacyPath, JSON.stringify({ review_type: 'code', legacy: true }, null, 2) + '\n', 'utf8');

            const resolvedPath = resolveCanonicalReviewContextPath({
                reviewsRoot,
                taskId: 'T-001',
                reviewType: 'code'
            });

            assert.equal(resolvedPath, canonicalPath);
            assert.equal(fs.existsSync(canonicalPath), true);
            assert.deepEqual(
                JSON.parse(fs.readFileSync(canonicalPath, 'utf8')),
                JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects explicit review-context paths that escape the repo through symlinked directories', (t) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-paths-link-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-paths-outside-'));
            try {
                const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
                fs.mkdirSync(reviewsRoot, { recursive: true });
                fs.writeFileSync(path.join(outsideRoot, 'context.json'), '{}\n', 'utf8');
                const linkedDirPath = path.join(reviewsRoot, 'linked-outside');
                try {
                    fs.symlinkSync(outsideRoot, linkedDirPath, process.platform === 'win32' ? 'junction' : 'dir');
                } catch (error) {
                    t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                    return;
                }

                assert.throws(() => resolveCanonicalReviewContextPath({
                    reviewsRoot,
                    taskId: 'T-001',
                    reviewType: 'code',
                    explicitPath: path.join(linkedDirPath, 'context.json'),
                    repoRoot
                }), /Path must resolve inside repo root without symlink or junction escapes/u);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
            }
        });
    });
});
