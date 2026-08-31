import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export const PASSWORD_RESET_DEFAULTS = Object.freeze({
    codeDigits: 6,
    ttlMs: 10 * 60 * 1000,
    maxAttempts: 5,
    resendCooldownMs: 60 * 1000,
    maxChallenges: 10_000
})

const PASSWORD_RESET_CODE_PATTERN = new RegExp(
    `^\\d{${PASSWORD_RESET_DEFAULTS.codeDigits}}$`,
    'u'
)

export const GENERIC_PASSWORD_RESET_MESSAGE =
    'If the account is available, a password reset code will be sent by WhatsApp.'

const STATE_VERSION = 1
const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const SECRET_TEXT_PATTERN = /^[A-Za-z0-9_-]{43}$/
const RECORD_FIELDS = new Set(['subject', 'codeHmac', 'issuedAt', 'expiresAt', 'attemptsUsed'])

function codedError(code, message, cause) {
    const error = new Error(message, cause ? { cause } : undefined)
    error.code = code
    return error
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSecret(secret) {
    const value = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret || ''), 'utf8')
    if (value.length < 32) {
        throw codedError('RESET_SECRET_INVALID', 'Password reset HMAC secret must contain at least 32 bytes.')
    }
    return value
}

function normalizeSubject(subject) {
    const value = String(subject || '').trim()
    if (!value || value.length > 256) {
        throw codedError('RESET_SUBJECT_INVALID', 'Password reset subject is invalid.')
    }
    return value
}

function emptyState() {
    return {
        version: STATE_VERSION,
        challenges: {}
    }
}

function validateRecord(challengeId, record) {
    if (!CHALLENGE_ID_PATTERN.test(challengeId) || !plainObject(record)) return false
    if (Object.keys(record).some(key => !RECORD_FIELDS.has(key))) return false
    if (typeof record.subject !== 'string' || !record.subject || record.subject.length > 256) return false
    if (!/^[a-f0-9]{64}$/.test(String(record.codeHmac || ''))) return false
    if (!Number.isFinite(record.issuedAt) || !Number.isFinite(record.expiresAt)) return false
    if (record.issuedAt < 0 || record.expiresAt <= record.issuedAt) return false
    if (!Number.isInteger(record.attemptsUsed) || record.attemptsUsed < 0) return false
    return true
}

function readStateStrict(statePath) {
    let text
    try {
        text = fs.readFileSync(statePath, 'utf8')
    } catch (error) {
        if (error?.code === 'ENOENT') return emptyState()
        throw codedError('RESET_STATE_READ_FAILED', 'Password reset state could not be read.', error)
    }

    try {
        const state = JSON.parse(text)
        if (!plainObject(state) || state.version !== STATE_VERSION || !plainObject(state.challenges)) {
            throw new Error('unsupported state structure')
        }
        for (const [challengeId, record] of Object.entries(state.challenges)) {
            if (!validateRecord(challengeId, record)) throw new Error('invalid challenge record')
        }
        return state
    } catch (error) {
        throw codedError('RESET_STATE_CORRUPT', 'Password reset state is invalid; refusing to overwrite it.', error)
    }
}

function fsyncDirectoryBestEffort(directory) {
    let descriptor
    try {
        descriptor = fs.openSync(directory, 'r')
        fs.fsyncSync(descriptor)
    } catch {
        // Directory fsync is not supported by every platform/filesystem.
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor) } catch {}
        }
    }
}

function writePasswordResetStateAtomic(statePath, state) {
    const target = path.resolve(statePath)
    const directory = path.dirname(target)
    fs.mkdirSync(directory, { recursive: true })
    const temporary = path.join(
        directory,
        `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
    )
    let descriptor
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600)
        fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = undefined
        fs.renameSync(temporary, target)
        try { fs.chmodSync(target, 0o600) } catch {}
        fsyncDirectoryBestEffort(directory)
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor) } catch {}
        }
        try { fs.unlinkSync(temporary) } catch {}
        throw codedError('RESET_STATE_WRITE_FAILED', 'Password reset state could not be saved.', error)
    }
}

function decodeStoredSecret(text) {
    const clean = String(text || '').trim()
    if (!SECRET_TEXT_PATTERN.test(clean)) {
        throw codedError('RESET_SECRET_FILE_INVALID', 'Password reset HMAC secret file is invalid.')
    }
    const decoded = Buffer.from(clean, 'base64url')
    if (decoded.length !== 32) {
        throw codedError('RESET_SECRET_FILE_INVALID', 'Password reset HMAC secret file is invalid.')
    }
    return clean
}

/**
 * Loads a stable 256-bit HMAC key, creating it with owner-only permissions on
 * first use. Keeping this key stable is required for challenges to survive a
 * process restart. An environment/secret-manager value may be used instead.
 */
export function loadOrCreatePasswordResetHmacSecret(secretPath) {
    if (!secretPath) throw codedError('RESET_SECRET_PATH_REQUIRED', 'Password reset HMAC secret path is required.')
    const target = path.resolve(secretPath)
    try {
        return decodeStoredSecret(fs.readFileSync(target, 'utf8'))
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            if (error?.code === 'RESET_SECRET_FILE_INVALID') throw error
            throw codedError('RESET_SECRET_READ_FAILED', 'Password reset HMAC secret could not be read.', error)
        }
    }

    const directory = path.dirname(target)
    fs.mkdirSync(directory, { recursive: true })
    const generated = generatePasswordResetHmacSecret()
    let descriptor
    let createdHere = false
    try {
        descriptor = fs.openSync(target, 'wx', 0o600)
        createdHere = true
        fs.writeFileSync(descriptor, `${generated}\n`, 'utf8')
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = undefined
        fsyncDirectoryBestEffort(directory)
        return generated
    } catch (error) {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor) } catch {}
        }
        if (error?.code === 'EEXIST') {
            try {
                return decodeStoredSecret(fs.readFileSync(target, 'utf8'))
            } catch (readError) {
                if (readError?.code === 'RESET_SECRET_FILE_INVALID') throw readError
                throw codedError('RESET_SECRET_READ_FAILED', 'Password reset HMAC secret could not be read.', readError)
            }
        }
        if (createdHere) {
            try { fs.unlinkSync(target) } catch {}
        }
        throw codedError('RESET_SECRET_WRITE_FAILED', 'Password reset HMAC secret could not be saved.', error)
    }
}

function definePrivate(result, key, value) {
    Object.defineProperty(result, key, {
        configurable: false,
        enumerable: false,
        writable: false,
        value
    })
    return result
}

function safeHook(callback, payload) {
    if (typeof callback !== 'function') return
    try { callback(payload) } catch {}
}

/**
 * Creates the durable reset-challenge store. The returned issue result has a
 * non-enumerable `delivery` field containing the transient code only when
 * `deliverable` is true. The code is never written to disk.
 */
export function createPasswordResetChallengeStore({
    statePath,
    hmacSecret,
    now = () => Date.now(),
    randomInt = crypto.randomInt,
    randomBytes = crypto.randomBytes,
    ttlMs = PASSWORD_RESET_DEFAULTS.ttlMs,
    maxAttempts = PASSWORD_RESET_DEFAULTS.maxAttempts,
    resendCooldownMs = PASSWORD_RESET_DEFAULTS.resendCooldownMs,
    maxChallenges = PASSWORD_RESET_DEFAULTS.maxChallenges,
    onInvalidated,
    onVerified,
    onReset
} = {}) {
    if (!statePath) throw codedError('RESET_STATE_PATH_REQUIRED', 'Password reset state path is required.')
    const filePath = path.resolve(statePath)
    const secret = normalizeSecret(hmacSecret)

    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw codedError('RESET_TTL_INVALID', 'Reset TTL is invalid.')
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
        throw codedError('RESET_ATTEMPTS_INVALID', 'Reset attempt limit is invalid.')
    }
    if (!Number.isSafeInteger(resendCooldownMs) || resendCooldownMs <= 0 || resendCooldownMs >= ttlMs) {
        throw codedError('RESET_COOLDOWN_INVALID', 'Reset resend cooldown is invalid.')
    }
    if (!Number.isSafeInteger(maxChallenges) || maxChallenges <= 0) {
        throw codedError('RESET_CAPACITY_INVALID', 'Reset challenge capacity is invalid.')
    }

    const codeCeiling = 10 ** PASSWORD_RESET_DEFAULTS.codeDigits

    const currentTimestamp = () => {
        const timestamp = Number(now())
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp + ttlMs > Number.MAX_SAFE_INTEGER) {
            throw codedError('RESET_CLOCK_INVALID', 'Password reset clock returned an invalid timestamp.')
        }
        return timestamp
    }

    const codeHmac = (challengeId, subject, code) => crypto
        .createHmac('sha256', secret)
        .update('netwatch-password-reset:v1\0')
        .update(challengeId)
        .update('\0')
        .update(subject)
        .update('\0')
        .update(String(code))
        .digest()

    const emitInvalidated = (challengeId, record, reason) => safeHook(onInvalidated, {
        challengeId,
        subject: record.subject,
        reason
    })

    const pruneExpired = (state, timestamp) => {
        const removed = []
        for (const [challengeId, record] of Object.entries(state.challenges)) {
            if (record.expiresAt <= timestamp) {
                delete state.challenges[challengeId]
                removed.push([challengeId, record])
            }
        }
        return removed
    }

    const saveIfChanged = (state, changed) => {
        if (changed) writePasswordResetStateAtomic(filePath, state)
    }

    const issue = ({ subject, deliverable = false } = {}) => {
        const normalizedSubject = normalizeSubject(subject)
        const timestamp = currentTimestamp()
        const state = readStateStrict(filePath)
        const expired = pruneExpired(state, timestamp)

        const existingEntry = Object.entries(state.challenges)
            .filter(([, record]) => record.subject === normalizedSubject)
            .sort((left, right) => right[1].issuedAt - left[1].issuedAt)[0]

        if (existingEntry) {
            const [challengeId, record] = existingEntry
            const resendAt = record.issuedAt + resendCooldownMs
            if (timestamp < resendAt) {
                saveIfChanged(state, expired.length > 0)
                for (const [expiredId, expiredRecord] of expired) {
                    emitInvalidated(expiredId, expiredRecord, 'expired')
                }
                const result = {
                    challengeId,
                    expiresAt: record.expiresAt,
                    resendAfter: resendAt
                }
                return definePrivate(result, 'delivery', null)
            }
        }

        const superseded = []
        for (const [challengeId, record] of Object.entries(state.challenges)) {
            if (record.subject === normalizedSubject) {
                delete state.challenges[challengeId]
                superseded.push([challengeId, record])
            }
        }

        const capacityEvicted = []
        const oldest = Object.entries(state.challenges)
            .sort((left, right) => left[1].issuedAt - right[1].issuedAt)
        while (oldest.length >= maxChallenges) {
            const entry = oldest.shift()
            if (!entry) break
            delete state.challenges[entry[0]]
            capacityEvicted.push(entry)
        }

        let challengeId
        do {
            const idBytes = Buffer.from(randomBytes(32))
            if (idBytes.length !== 32) {
                throw codedError('RESET_RANDOM_INVALID', 'Password reset challenge randomness is invalid.')
            }
            challengeId = idBytes.toString('base64url')
        } while (Object.hasOwn(state.challenges, challengeId))

        const codeNumber = randomInt(0, codeCeiling)
        if (!Number.isInteger(codeNumber) || codeNumber < 0 || codeNumber >= codeCeiling) {
            throw codedError('RESET_RANDOM_INVALID', 'Password reset code randomness is invalid.')
        }
        const code = String(codeNumber).padStart(PASSWORD_RESET_DEFAULTS.codeDigits, '0')
        const expiresAt = timestamp + ttlMs
        const resendAfter = timestamp + resendCooldownMs
        state.challenges[challengeId] = {
            subject: normalizedSubject,
            codeHmac: codeHmac(challengeId, normalizedSubject, code).toString('hex'),
            issuedAt: timestamp,
            expiresAt,
            attemptsUsed: 0
        }
        writePasswordResetStateAtomic(filePath, state)
        for (const [supersededId, supersededRecord] of superseded) {
            emitInvalidated(supersededId, supersededRecord, 'superseded')
        }
        for (const [evictedId, evictedRecord] of capacityEvicted) {
            emitInvalidated(evictedId, evictedRecord, 'capacity-evicted')
        }
        for (const [expiredId, expiredRecord] of expired) {
            emitInvalidated(expiredId, expiredRecord, 'expired')
        }

        const result = { challengeId, expiresAt, resendAfter }
        const delivery = deliverable === true
            ? Object.freeze({ challengeId, subject: normalizedSubject, code, expiresAt })
            : null
        return definePrivate(result, 'delivery', delivery)
    }

    const verify = ({ challengeId, code } = {}) => {
        const normalizedId = String(challengeId || '')
        const timestamp = currentTimestamp()
        const state = readStateStrict(filePath)
        const expired = pruneExpired(state, timestamp)
        const record = CHALLENGE_ID_PATTERN.test(normalizedId) && Object.hasOwn(state.challenges, normalizedId)
            ? state.challenges[normalizedId]
            : null

        if (!record) {
            saveIfChanged(state, expired.length > 0)
            for (const [expiredId, expiredRecord] of expired) {
                emitInvalidated(expiredId, expiredRecord, 'expired')
            }
            return { ok: false, status: 'invalid_or_expired', attemptsRemaining: 0 }
        }

        const codeText = String(code ?? '').slice(0, PASSWORD_RESET_DEFAULTS.codeDigits + 1)
        const candidate = codeHmac(normalizedId, record.subject, codeText)
        const expected = Buffer.from(record.codeHmac, 'hex')
        const digestMatches = expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)
        const valid = PASSWORD_RESET_CODE_PATTERN.test(codeText) && digestMatches

        if (!valid) {
            record.attemptsUsed += 1
            const attemptsRemaining = Math.max(0, maxAttempts - record.attemptsUsed)
            let exhaustedRecord = null
            if (attemptsRemaining === 0) {
                delete state.challenges[normalizedId]
                exhaustedRecord = record
            }
            writePasswordResetStateAtomic(filePath, state)
            if (exhaustedRecord) emitInvalidated(normalizedId, exhaustedRecord, 'attempts-exhausted')
            for (const [expiredId, expiredRecord] of expired) {
                emitInvalidated(expiredId, expiredRecord, 'expired')
            }
            return { ok: false, status: 'invalid_code', attemptsRemaining }
        }

        delete state.challenges[normalizedId]
        writePasswordResetStateAtomic(filePath, state)
        for (const [expiredId, expiredRecord] of expired) {
            emitInvalidated(expiredId, expiredRecord, 'expired')
        }
        const result = { ok: true, status: 'verified' }
        definePrivate(result, 'subject', record.subject)
        definePrivate(result, 'challengeId', normalizedId)
        safeHook(onVerified, { challengeId: normalizedId, subject: record.subject })
        return result
    }

    /**
     * Verifies a challenge, runs the authoritative password commit, and only
     * consumes the challenge after that commit succeeds. JavaScript execution
     * is single-threaded here, so the synchronous transaction also prevents a
     * second same-process confirmation from using the challenge concurrently.
     */
    const verifyAndCommit = ({ challengeId, code } = {}, commit) => {
        if (typeof commit !== 'function') {
            throw codedError('RESET_COMMIT_REQUIRED', 'A password reset commit callback is required.')
        }
        const normalizedId = String(challengeId || '')
        const timestamp = currentTimestamp()
        const state = readStateStrict(filePath)
        const expired = pruneExpired(state, timestamp)
        const record = CHALLENGE_ID_PATTERN.test(normalizedId) && Object.hasOwn(state.challenges, normalizedId)
            ? state.challenges[normalizedId]
            : null

        if (!record) {
            saveIfChanged(state, expired.length > 0)
            for (const [expiredId, expiredRecord] of expired) emitInvalidated(expiredId, expiredRecord, 'expired')
            return { ok: false, status: 'invalid_or_expired', attemptsRemaining: 0 }
        }

        const codeText = String(code ?? '').slice(0, PASSWORD_RESET_DEFAULTS.codeDigits + 1)
        const candidate = codeHmac(normalizedId, record.subject, codeText)
        const expected = Buffer.from(record.codeHmac, 'hex')
        const digestMatches = expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)
        const valid = PASSWORD_RESET_CODE_PATTERN.test(codeText) && digestMatches
        if (!valid) {
            record.attemptsUsed += 1
            const attemptsRemaining = Math.max(0, maxAttempts - record.attemptsUsed)
            if (!attemptsRemaining) delete state.challenges[normalizedId]
            writePasswordResetStateAtomic(filePath, state)
            if (!attemptsRemaining) emitInvalidated(normalizedId, record, 'attempts-exhausted')
            for (const [expiredId, expiredRecord] of expired) emitInvalidated(expiredId, expiredRecord, 'expired')
            return { ok: false, status: 'invalid_code', attemptsRemaining }
        }

        // Deliberately do not persist the pruned state before the callback: a
        // failed password write leaves the valid reset challenge untouched.
        commit(record.subject)
        const committedState = readStateStrict(filePath)
        const committedRecord = committedState.challenges[normalizedId]
        if (committedRecord && committedRecord.codeHmac !== record.codeHmac) {
            throw codedError('RESET_CHALLENGE_CHANGED', 'The password reset challenge changed during confirmation.')
        }
        if (committedRecord) {
            delete committedState.challenges[normalizedId]
            writePasswordResetStateAtomic(filePath, committedState)
        }
        const result = { ok: true, status: 'verified' }
        definePrivate(result, 'subject', record.subject)
        definePrivate(result, 'challengeId', normalizedId)
        safeHook(onVerified, { challengeId: normalizedId, subject: record.subject })
        return result
    }

    const invalidateChallenge = (challengeId, reason = 'invalidated') => {
        const normalizedId = String(challengeId || '')
        const state = readStateStrict(filePath)
        if (!CHALLENGE_ID_PATTERN.test(normalizedId) || !Object.hasOwn(state.challenges, normalizedId)) return false
        const record = state.challenges[normalizedId]
        delete state.challenges[normalizedId]
        writePasswordResetStateAtomic(filePath, state)
        emitInvalidated(normalizedId, record, String(reason || 'invalidated'))
        return true
    }

    const invalidateSubject = (subject, reason = 'subject-invalidated') => {
        const normalizedSubject = normalizeSubject(subject)
        const state = readStateStrict(filePath)
        const removed = []
        for (const [challengeId, record] of Object.entries(state.challenges)) {
            if (record.subject === normalizedSubject) {
                delete state.challenges[challengeId]
                removed.push([challengeId, record])
            }
        }
        saveIfChanged(state, removed.length > 0)
        for (const [challengeId, record] of removed) emitInvalidated(challengeId, record, reason)
        return removed.length
    }

    const resetState = (reason = 'store-reset') => {
        const state = readStateStrict(filePath)
        const removed = Object.entries(state.challenges)
        writePasswordResetStateAtomic(filePath, emptyState())
        for (const [challengeId, record] of removed) emitInvalidated(challengeId, record, reason)
        safeHook(onReset, { reason, removed: removed.length })
        return removed.length
    }

    return Object.freeze({
        issue,
        verify,
        verifyAndCommit,
        invalidateChallenge,
        invalidateSubject,
        resetState
    })
}

export function toGenericPasswordResetResponse(issueResult) {
    return {
        ok: true,
        message: GENERIC_PASSWORD_RESET_MESSAGE,
        challengeId: String(issueResult?.challengeId || ''),
        expiresAt: Number(issueResult?.expiresAt || 0),
        resendAfter: Number(issueResult?.resendAfter || 0)
    }
}

export function generatePasswordResetHmacSecret() {
    return crypto.randomBytes(32).toString('base64url')
}
