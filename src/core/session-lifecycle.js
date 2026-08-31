import fs from 'fs'
import path from 'path'

function codedError(code, message) {
    const error = new Error(message)
    error.code = code
    return error
}

export function createLifecycleGate() {
    let active = null

    return {
        get active() {
            return active
        },
        async run(name, operation) {
            if (active) {
                throw codedError(
                    'SESSION_BUSY',
                    `Another session action is already in progress: ${active.name}.`
                )
            }
            const token = {
                name: String(name || 'session-action'),
                retiringSocket: null
            }
            active = token
            try {
                return await operation(token)
            } finally {
                if (active === token) active = null
            }
        }
    }
}

export function resetAuthDirectoryStrict(sessionRoot, authDir) {
    const root = path.resolve(sessionRoot)
    const target = path.resolve(authDir)
    if (target !== path.join(root, 'auth')) {
        throw codedError('AUTH_PATH_INVALID', 'Refusing to reset an unexpected authentication path.')
    }

    if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw codedError('AUTH_PATH_INVALID', 'Authentication path must be a real directory.')
        }
        fs.rmSync(target, { recursive: true, force: false })
    }
    if (fs.existsSync(target)) {
        throw codedError('AUTH_RESET_FAILED', 'Authentication directory could not be removed completely.')
    }

    fs.mkdirSync(target, { recursive: false })
    const recreated = fs.lstatSync(target)
    if (recreated.isSymbolicLink() || !recreated.isDirectory() || fs.readdirSync(target).length) {
        throw codedError('AUTH_RESET_FAILED', 'Authentication directory was not recreated empty.')
    }
    return target
}

export function writeJsonAtomicStrict(filePath, value) {
    const parent = path.dirname(filePath)
    fs.mkdirSync(parent, { recursive: true })
    const tempPath = path.join(
        parent,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    )
    try {
        fs.writeFileSync(tempPath, JSON.stringify(value, null, 2))
        fs.renameSync(tempPath, filePath)
    } catch (error) {
        try { fs.unlinkSync(tempPath) } catch {}
        throw error
    }
}

