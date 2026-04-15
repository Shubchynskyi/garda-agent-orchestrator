const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUILD_ROOT_LOCK_TIMEOUT_MS = 120000;
const BUILD_ROOT_LOCK_METADATA_GRACE_MS = 30000;
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

function toPositiveInteger(value, fallback) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function normalizeHostname(hostname) {
    const trimmed = typeof hostname === 'string' ? hostname.trim() : '';
    return trimmed ? trimmed.toLowerCase() : null;
}

function isCurrentHostOwner(hostname) {
    const ownerHost = normalizeHostname(hostname);
    if (!ownerHost) {
        return null;
    }
    return ownerHost === normalizeHostname(os.hostname());
}

function normalizeBuildRootLockOptions(options = {}) {
    return {
        timeoutMs: toPositiveInteger(options.timeoutMs, BUILD_ROOT_LOCK_TIMEOUT_MS),
        metadataGraceMs: toPositiveInteger(options.metadataGraceMs, BUILD_ROOT_LOCK_METADATA_GRACE_MS),
        staleMs: toPositiveInteger(options.staleMs, BUILD_ROOT_LOCK_STALE_MS),
        backoffBaseMs: toPositiveInteger(options.backoffBaseMs, BUILD_ROOT_LOCK_BACKOFF_BASE_MS),
        backoffMultiplier: Number(options.backoffMultiplier) > 1
            ? Number(options.backoffMultiplier)
            : BUILD_ROOT_LOCK_BACKOFF_MULTIPLIER,
        backoffMaxMs: toPositiveInteger(options.backoffMaxMs, BUILD_ROOT_LOCK_BACKOFF_MAX_MS)
    };
}

function computeBackoffDelayWithOptions(attempt, options) {
    const delay = options.backoffBaseMs * Math.pow(options.backoffMultiplier, attempt);
    const jitter = Math.random() * options.backoffBaseMs;
    return Math.min(delay + jitter, options.backoffMaxMs);
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
    const ownerPath = path.join(lockPath, BUILD_ROOT_LOCK_OWNER_FILENAME);
    try {
        const raw = fs.readFileSync(ownerPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed == null || typeof parsed !== 'object') {
            return {
                metadataStatus: 'invalid_shape',
                owner: {
                    pid: null,
                    hostname: null,
                    startedAtUtc: null
                }
            };
        }

        const owner = {
            pid: Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
            hostname: typeof parsed.hostname === 'string' && parsed.hostname.trim()
                ? parsed.hostname.trim()
                : null,
            startedAtUtc: typeof parsed.startedAtUtc === 'string' && parsed.startedAtUtc.trim()
                ? parsed.startedAtUtc.trim()
                : null
        };

        return {
            metadataStatus: owner.pid !== null ? 'ok' : 'invalid_shape',
            owner
        };
    } catch (error) {
        const errorCode = getErrorCode(error);
        if (errorCode === 'ENOENT') {
            return {
                metadataStatus: 'missing',
                owner: {
                    pid: null,
                    hostname: null,
                    startedAtUtc: null
                }
            };
        }
        if (errorCode === 'EPERM' || errorCode === 'EACCES' || errorCode === 'EBUSY') {
            return {
                metadataStatus: 'transient_read_error',
                owner: {
                    pid: null,
                    hostname: null,
                    startedAtUtc: null
                }
            };
        }
        if (error instanceof SyntaxError) {
            return {
                metadataStatus: 'invalid_json',
                owner: {
                    pid: null,
                    hostname: null,
                    startedAtUtc: null
                }
            };
        }
        return {
            metadataStatus: 'read_error',
            owner: {
                pid: null,
                hostname: null,
                startedAtUtc: null
            }
        };
    }
}

function inspectBuildRootLock(lockPath, options = {}) {
    const normalizedOptions = normalizeBuildRootLockOptions(options);
    let stats;
    try {
        stats = fs.statSync(lockPath);
    } catch (error) {
        const errorCode = getErrorCode(error);
        if (errorCode === 'ENOENT') {
            return {
                exists: false,
                ageMs: null,
                metadataStatus: 'missing',
                ownerHostMatchesCurrent: null,
                ownerAlive: null,
                staleReason: null,
                owner: {
                    pid: null,
                    hostname: null,
                    startedAtUtc: null
                }
            };
        }
        throw error;
    }

    const ownerState = readBuildRootLockOwner(lockPath);
    const owner = ownerState.owner;
    const lockAgeMs = Math.max(0, Date.now() - stats.mtimeMs);
    const ownerHostMatchesCurrent = isCurrentHostOwner(owner.hostname);
    let ownerAlive = null;
    let staleReason = null;
    const metadataNeedsLongGrace = ownerState.metadataStatus === 'missing'
        || ownerState.metadataStatus === 'invalid_json'
        || ownerState.metadataStatus === 'invalid_shape';
    const metadataNeedsStaleWindow = ownerState.metadataStatus === 'transient_read_error'
        || ownerState.metadataStatus === 'read_error';

    if (owner.pid !== null) {
        if (ownerHostMatchesCurrent !== false) {
            ownerAlive = isProcessLikelyAlive(owner.pid);
        }
    }

    if (ownerAlive === false) {
        staleReason = 'owner_dead';
    } else if (owner.pid === null) {
        if (ownerHostMatchesCurrent === false) {
            if (lockAgeMs >= normalizedOptions.staleMs) {
                staleReason = 'age_exceeded_foreign_host';
            }
        } else if (metadataNeedsLongGrace && lockAgeMs >= normalizedOptions.metadataGraceMs) {
            staleReason = 'metadata_incomplete';
        } else if (metadataNeedsStaleWindow && lockAgeMs >= normalizedOptions.staleMs) {
            staleReason = 'metadata_unreadable';
        }
    } else if (ownerHostMatchesCurrent === false && lockAgeMs >= normalizedOptions.staleMs) {
        staleReason = 'age_exceeded_foreign_host';
    }

    return {
        exists: true,
        ageMs: lockAgeMs,
        metadataStatus: ownerState.metadataStatus,
        ownerHostMatchesCurrent,
        ownerAlive,
        staleReason,
        owner
    };
}

function buildRootLockIsStale(lockPath, options = {}) {
    return inspectBuildRootLock(lockPath, options).staleReason !== null;
}

function formatBuildRootLockDiagnostics(lockPath, inspection) {
    if (!inspection || inspection.exists !== true) {
        return `lock='${lockPath}', exists=false`;
    }

    const ownerHost = inspection.owner.hostname ? normalizeHostname(inspection.owner.hostname) : null;
    const ownerHostLabel = inspection.ownerHostMatchesCurrent === true
        ? 'current'
        : (inspection.ownerHostMatchesCurrent === false ? `foreign:${ownerHost || 'unknown'}` : 'unknown');
    const ownerAlive = inspection.ownerAlive === true
        ? 'true'
        : (inspection.ownerAlive === false ? 'false' : 'unknown');

    return [
        `lock='${lockPath}'`,
        `metadata_status=${inspection.metadataStatus}`,
        `age_ms=${inspection.ageMs != null ? inspection.ageMs : 'unknown'}`,
        `owner_pid=${inspection.owner.pid != null ? inspection.owner.pid : 'unknown'}`,
        `owner_host=${ownerHostLabel}`,
        `owner_alive=${ownerAlive}`,
        `stale_reason=${inspection.staleReason || 'none'}`
    ].join(', ');
}

function tryRemoveStaleBuildRootLock(lockPath, options = {}) {
    const inspection = inspectBuildRootLock(lockPath, options);
    if (inspection.staleReason === null) {
        return {
            removed: false,
            inspection
        };
    }

    try {
        fs.rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        return {
            removed: true,
            inspection
        };
    } catch {
        return {
            removed: false,
            inspection
        };
    }
}

function acquireBuildRootLock(lockPath, options = {}) {
    const normalizedOptions = normalizeBuildRootLockOptions(options);
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
                if (tryRemoveStaleBuildRootLock(lockPath, normalizedOptions).removed) {
                    continue;
                }
            } else if (errorCode === 'EPERM' || errorCode === 'EACCES' || errorCode === 'EBUSY') {
                // Retryable contention/transient filesystem errors on Windows.
            } else {
                throw error;
            }
            if (Date.now() - startedAt >= normalizedOptions.timeoutMs) {
                const staleRecovery = tryRemoveStaleBuildRootLock(lockPath, normalizedOptions);
                if (staleRecovery.removed) {
                    continue;
                }
                throw new Error(
                    `Timed out acquiring build root lock: ${lockPath}. ` +
                    `${formatBuildRootLockDiagnostics(lockPath, staleRecovery.inspection)}`
                );
            }
            sleepSync(computeBackoffDelayWithOptions(attempt, normalizedOptions));
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

function withBuildRootLock(buildRoot, operation, options = {}) {
    const lockPath = getBuildRootLockPath(buildRoot);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    acquireBuildRootLock(lockPath, options);
    try {
        return operation();
    } finally {
        releaseBuildRootLock(lockPath);
    }
}

module.exports = {
    acquireBuildRootLock,
    buildRootLockIsStale,
    getBuildRootLockPath,
    inspectBuildRootLock,
    releaseBuildRootLock,
    resetBuildRoot,
    sleepSync,
    withBuildRootLock
};
