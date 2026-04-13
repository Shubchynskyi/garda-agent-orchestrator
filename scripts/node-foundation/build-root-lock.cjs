const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUILD_ROOT_LOCK_TIMEOUT_MS = 120000;
const BUILD_ROOT_LOCK_STALE_MS = 15 * 60 * 1000;
const BUILD_ROOT_LOCK_BACKOFF_BASE_MS = 50;
const BUILD_ROOT_LOCK_BACKOFF_MULTIPLIER = 2;
const BUILD_ROOT_LOCK_BACKOFF_MAX_MS = 2000;
const BUILD_ROOT_LOCK_RELEASE_MAX_RETRIES = 3;
const BUILD_ROOT_LOCK_OWNER_FILENAME = 'owner.json';

function getErrorCode(error) {
    return error != null && typeof error === 'object' && 'code' in error
        ? String(error.code || '')
        : '';
}

function sleepSync(milliseconds) {
    if (!milliseconds || milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function computeBackoffDelay(attempt) {
    const delay = BUILD_ROOT_LOCK_BACKOFF_BASE_MS * Math.pow(BUILD_ROOT_LOCK_BACKOFF_MULTIPLIER, attempt);
    const jitter = Math.random() * BUILD_ROOT_LOCK_BACKOFF_BASE_MS;
    return Math.min(delay + jitter, BUILD_ROOT_LOCK_BACKOFF_MAX_MS);
}

function isRetryableBuildRootLockError(error) {
    const errorCode = getErrorCode(error);
    return errorCode === 'EEXIST' || errorCode === 'EPERM' || errorCode === 'EACCES' || errorCode === 'EBUSY';
}

function isProcessLikelyAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const errorCode = getErrorCode(error);
        if (errorCode === 'ESRCH') {
            return false;
        }
        if (errorCode === 'EPERM') {
            return true;
        }
        return null;
    }
}

function readBuildRootLockOwner(lockPath) {
    try {
        const raw = fs.readFileSync(path.join(lockPath, BUILD_ROOT_LOCK_OWNER_FILENAME), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed != null && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        const errorCode = getErrorCode(error);
        if (errorCode === 'ENOENT') {
            return null;
        }
        return null;
    }
}

function buildRootLockIsStale(lockPath) {
    let stats;
    try {
        stats = fs.statSync(lockPath);
    } catch (error) {
        const errorCode = getErrorCode(error);
        if (errorCode === 'ENOENT') {
            return false;
        }
        throw error;
    }

    const owner = readBuildRootLockOwner(lockPath);
    const lockAgeMs = Math.max(0, Date.now() - stats.mtimeMs);
    const localHostname = os.hostname();
    let ownerAlive = null;

    if (owner != null && Number.isInteger(owner.pid) && owner.pid > 0) {
        if (typeof owner.hostname !== 'string' || owner.hostname.length === 0 || owner.hostname === localHostname) {
            ownerAlive = isProcessLikelyAlive(owner.pid);
        } else {
            return false;
        }
    }

    if (ownerAlive === false) {
        return true;
    }

    return lockAgeMs >= BUILD_ROOT_LOCK_STALE_MS && ownerAlive !== true;
}

function tryRemoveStaleBuildRootLock(lockPath) {
    if (!buildRootLockIsStale(lockPath)) {
        return false;
    }

    try {
        fs.rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        return true;
    } catch {
        return false;
    }
}

function acquireBuildRootLock(lockPath) {
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
        try {
            fs.mkdirSync(lockPath);
            try {
                fs.writeFileSync(path.join(lockPath, BUILD_ROOT_LOCK_OWNER_FILENAME), JSON.stringify({
                    hostname: os.hostname(),
                    pid: process.pid,
                    startedAtUtc: new Date().toISOString()
                }, null, 2) + '\n', 'utf8');
            } catch (error) {
                fs.rmSync(lockPath, { recursive: true, force: true });
                throw error;
            }
            return;
        } catch (error) {
            const errorCode = getErrorCode(error);
            if (errorCode === 'EEXIST') {
                if (tryRemoveStaleBuildRootLock(lockPath)) {
                    continue;
                }
            } else if (errorCode === 'EPERM' || errorCode === 'EACCES' || errorCode === 'EBUSY') {
                // Retryable contention/transient filesystem errors on Windows.
            } else {
                throw error;
            }
            if (Date.now() - startedAt >= BUILD_ROOT_LOCK_TIMEOUT_MS) {
                if (tryRemoveStaleBuildRootLock(lockPath)) {
                    continue;
                }
                throw new Error(`Timed out acquiring build root lock: ${lockPath}`);
            }
            sleepSync(computeBackoffDelay(attempt));
            attempt += 1;
        }
    }
}

function releaseBuildRootLock(lockPath) {
    for (let attempt = 0; attempt <= BUILD_ROOT_LOCK_RELEASE_MAX_RETRIES; attempt += 1) {
        try {
            fs.rmSync(lockPath, { recursive: true, force: true });
            return;
        } catch (error) {
            if (isRetryableBuildRootLockError(error) && attempt < BUILD_ROOT_LOCK_RELEASE_MAX_RETRIES) {
                sleepSync(computeBackoffDelay(attempt));
                continue;
            }
            // best-effort lock cleanup
            return;
        }
    }
}

function getBuildRootLockPath(buildRoot) {
    return `${buildRoot}.lock`;
}

function resetBuildRoot(buildRoot) {
    fs.mkdirSync(buildRoot, { recursive: true });

    for (const entry of fs.readdirSync(buildRoot, { withFileTypes: true })) {
        fs.rmSync(path.join(buildRoot, entry.name), {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50
        });
    }
}

function withBuildRootLock(buildRoot, operation) {
    const lockPath = getBuildRootLockPath(buildRoot);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    acquireBuildRootLock(lockPath);
    try {
        return operation();
    } finally {
        releaseBuildRootLock(lockPath);
    }
}

module.exports = {
    acquireBuildRootLock,
    getBuildRootLockPath,
    releaseBuildRootLock,
    resetBuildRoot,
    sleepSync,
    withBuildRootLock
};
