import fs from 'fs'
import path from 'path'

const DEFAULT_SWEEP_LIMIT = 100_000

function assertSafeManagedAncestors(root, candidate) {
    let current = path.dirname(candidate)
    while (current !== root) {
        let stat
        try {
            stat = fs.lstatSync(current)
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error
            current = path.dirname(current)
            continue
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            const error = new Error('Temporary media path cannot traverse a link or non-directory')
            error.code = 'UNSAFE_MEDIA_CACHE_PATH'
            throw error
        }
        current = path.dirname(current)
    }
}

function resolvedManagedPath(rootDir, filePath) {
    const root = path.resolve(String(rootDir || ''))
    const candidate = path.resolve(String(filePath || ''))
    const relative = path.relative(root, candidate)
    if (!rootDir || !filePath || !relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        const error = new Error('Temporary media path must be a file below its cache directory')
        error.code = 'UNMANAGED_MEDIA_PATH'
        throw error
    }
    assertSafeManagedAncestors(root, candidate)
    return { root, candidate }
}

function ensureSafeRoot(rootDir) {
    const root = path.resolve(String(rootDir || ''))
    if (!rootDir || path.parse(root).root === root) {
        const error = new Error('Temporary media cache must not be a filesystem root')
        error.code = 'UNSAFE_MEDIA_CACHE_ROOT'
        throw error
    }
    fs.mkdirSync(root, { recursive: true })
    const stat = fs.lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        const error = new Error('Temporary media cache must be a real directory, not a link')
        error.code = 'UNSAFE_MEDIA_CACHE_ROOT'
        throw error
    }
    return root
}

function removeManagedFile(rootDir, filePath) {
    const { candidate } = resolvedManagedPath(rootDir, filePath)
    let stat
    try {
        stat = fs.lstatSync(candidate)
    } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const error = new Error('A temporary media lease cannot delete a directory')
        error.code = 'MEDIA_LEASE_IS_DIRECTORY'
        throw error
    }
    fs.unlinkSync(candidate)
    return true
}

function assertUsableMediaFile(filePath, { allowEmpty = false } = {}) {
    let stat
    try {
        stat = fs.lstatSync(filePath)
    } catch (error) {
        if (error?.code === 'ENOENT') {
            const missing = new Error('Temporary media producer did not create a file')
            missing.code = 'MEDIA_FILE_MISSING'
            throw missing
        }
        throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        const error = new Error('Temporary media must be a regular file')
        error.code = 'INVALID_MEDIA_FILE'
        throw error
    }
    if (!allowEmpty && stat.size === 0) {
        const error = new Error('Temporary media must not be empty')
        error.code = 'EMPTY_MEDIA_FILE'
        throw error
    }
    return stat
}

async function releaseAfterFailure(lease, error) {
    try {
        lease.release()
    } catch (cleanupError) {
        throw new AggregateError(
            [error, cleanupError],
            String(error?.message || error || 'Temporary media operation failed'),
            { cause: error }
        )
    }
    throw error
}

function sweepChildren(root, activePaths, limit) {
    const result = {
        removedFiles: 0,
        removedDirectories: 0,
        skippedActive: 0,
        failures: [],
        limitReached: false
    }
    let visited = 0
    const hasActiveDescendant = directory => {
        const prefix = `${directory}${path.sep}`
        for (const activePath of activePaths) {
            if (activePath.startsWith(prefix)) return true
        }
        return false
    }

    const visit = directory => {
        let entries
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true })
        } catch (error) {
            result.failures.push({ path: directory, error: String(error?.message || error) })
            return
        }

        for (const entry of entries) {
            if (visited >= limit) {
                result.limitReached = true
                return
            }
            visited += 1
            const target = path.join(directory, entry.name)
            if (activePaths.has(target)) {
                result.skippedActive += 1
                continue
            }

            try {
                const stat = fs.lstatSync(target)
                if (stat.isDirectory() && !stat.isSymbolicLink()) {
                    visit(target)
                    if (result.limitReached) return
                    if (!hasActiveDescendant(target) && !fs.readdirSync(target).length) {
                        fs.rmdirSync(target)
                        result.removedDirectories += 1
                    }
                } else {
                    fs.unlinkSync(target)
                    result.removedFiles += 1
                }
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    result.failures.push({ path: target, error: String(error?.message || error) })
                }
            }
        }
    }

    visit(root)
    return Object.freeze({ ...result, failures: Object.freeze(result.failures) })
}

export function sweepTemporaryMediaDirectory(cacheDir, {
    activePaths = [],
    maxEntries = DEFAULT_SWEEP_LIMIT
} = {}) {
    const root = ensureSafeRoot(cacheDir)
    const normalizedActive = new Set()
    for (const filePath of activePaths) {
        const { candidate } = resolvedManagedPath(root, filePath)
        normalizedActive.add(candidate)
    }
    const limit = Math.max(1, Number(maxEntries) || DEFAULT_SWEEP_LIMIT)
    return sweepChildren(root, normalizedActive, limit)
}

/**
 * Owns temporary media files for one session. Acquiring the same path more
 * than once is reference counted; the file is removed only after its last
 * consumer releases it. Startup sweep removes orphaned files left by a crash.
 */
export function createTemporaryMediaManager(cacheDir, {
    maxSweepEntries = DEFAULT_SWEEP_LIMIT,
    sweepOnStart = true
} = {}) {
    const rootDir = ensureSafeRoot(cacheDir)
    const references = new Map()
    const producing = new Set()
    let closed = false

    const sweepOrphans = () => sweepTemporaryMediaDirectory(rootDir, {
        activePaths: Array.from(references.keys()),
        maxEntries: maxSweepEntries
    })

    const startupSweep = sweepOnStart ? sweepOrphans() : null

    const createLease = (filePath, {
        allowProducing = false,
        requireExisting = true
    } = {}) => {
        if (closed) {
            const error = new Error('Temporary media manager is closed')
            error.code = 'MEDIA_MANAGER_CLOSED'
            throw error
        }
        const { candidate } = resolvedManagedPath(rootDir, filePath)
        if (!allowProducing && producing.has(candidate)) {
            const error = new Error('Temporary media path is still being produced')
            error.code = 'MEDIA_PATH_BUSY'
            throw error
        }
        if (requireExisting) assertUsableMediaFile(candidate)
        references.set(candidate, (references.get(candidate) || 0) + 1)
        let released = false

        return Object.freeze({
            path: candidate,
            get released() { return released },
            release() {
                if (released) return false
                released = true
                const remaining = Math.max(0, (references.get(candidate) || 1) - 1)
                if (remaining) {
                    references.set(candidate, remaining)
                    return false
                }
                references.delete(candidate)
                return removeManagedFile(rootDir, candidate)
            }
        })
    }

    const acquire = filePath => createLease(filePath)

    const withFile = async (filePath, consumer) => {
        if (typeof consumer !== 'function') throw new TypeError('Temporary media consumer must be a function')
        const lease = acquire(filePath)
        try {
            const result = await consumer(lease.path)
            lease.release()
            return result
        } catch (error) {
            if (lease.released) throw error
            return releaseAfterFailure(lease, error)
        }
    }

    const produce = async (filePath, producer, { allowEmpty = false } = {}) => {
        if (typeof producer !== 'function') throw new TypeError('Temporary media producer must be a function')
        const { candidate } = resolvedManagedPath(rootDir, filePath)
        if (references.has(candidate)) {
            const error = new Error('Temporary media path is already in use')
            error.code = 'MEDIA_PATH_BUSY'
            throw error
        }
        if (fs.existsSync(candidate)) {
            const error = new Error('Temporary media producer cannot overwrite an existing path')
            error.code = 'MEDIA_PATH_EXISTS'
            throw error
        }

        producing.add(candidate)
        const lease = createLease(candidate, {
            allowProducing: true,
            requireExisting: false
        })
        try {
            await producer(candidate)
            assertSafeManagedAncestors(rootDir, candidate)
            assertUsableMediaFile(candidate, { allowEmpty })
            producing.delete(candidate)
            return lease
        } catch (error) {
            producing.delete(candidate)
            return releaseAfterFailure(lease, error)
        }
    }

    const withProducedFile = async (filePath, producer, consumer, options) => {
        if (typeof consumer !== 'function') throw new TypeError('Temporary media consumer must be a function')
        const lease = await produce(filePath, producer, options)
        try {
            const result = await consumer(lease.path)
            lease.release()
            return result
        } catch (error) {
            if (lease.released) throw error
            return releaseAfterFailure(lease, error)
        }
    }

    const close = ({ sweep = true } = {}) => {
        closed = true
        return sweep ? sweepOrphans() : null
    }

    return Object.freeze({
        acquire,
        close,
        isManagedPath(filePath) {
            try {
                resolvedManagedPath(rootDir, filePath)
                return true
            } catch {
                return false
            }
        },
        produce,
        rootDir,
        startupSweep,
        sweepOrphans,
        withFile,
        withProducedFile,
        get activeLeaseCount() {
            let count = 0
            for (const value of references.values()) count += value
            return count
        }
    })
}

