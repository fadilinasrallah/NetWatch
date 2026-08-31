import crypto from 'crypto'

export const CONNECTION_MODE_QR = 'qr'
export const CONNECTION_MODE_CODE = 'code'
export const LINK_PHASES = Object.freeze({
    STARTING: 'starting',
    AWAITING_QR: 'awaiting_qr',
    AWAITING_CODE: 'awaiting_code',
    ACCEPTED: 'accepted',
    CONNECTING: 'connecting',
    EXPIRED: 'expired',
    ERROR: 'error'
})

const CROCKFORD_CODE = /^[1-9A-HJ-NP-TV-Z]{8}$/u
const E164_DIGITS = /^[1-9]\d{7,14}$/u

const codedError = (code, message) => {
    const error = new Error(message)
    error.code = code
    return error
}

export function normalizeConnectionMode(value, { fallback = CONNECTION_MODE_QR } = {}) {
    const raw = value == null || value === '' ? fallback : String(value).trim().toLowerCase()
    if (raw === CONNECTION_MODE_QR || raw === CONNECTION_MODE_CODE) return raw
    throw codedError('INVALID_CONNECTION_MODE', 'Choose either QR code or phone code.')
}

export function validatePairingPhone(value) {
    const digits = String(value ?? '').trim()
    if (!E164_DIGITS.test(digits)) {
        throw codedError(
            'INVALID_PAIRING_PHONE',
            'The session phone must contain 8 to 15 digits, including its country code, without a leading zero.'
        )
    }
    return digits
}

export function normalizeIssuedPairingCode(value) {
    const code = String(value ?? '').trim().toUpperCase()
    if (!CROCKFORD_CODE.test(code)) {
        throw codedError('INVALID_PAIRING_CODE', 'WhatsApp returned an invalid phone-linking code. Try a new attempt.')
    }
    return code
}

export function authCredentialsAreComplete(raw) {
    const hasKeys = Boolean(
        raw?.noiseKey?.private &&
        raw?.noiseKey?.public &&
        raw?.pairingEphemeralKeyPair?.private &&
        raw?.pairingEphemeralKeyPair?.public &&
        raw?.signedIdentityKey?.private &&
        raw?.signedIdentityKey?.public &&
        raw?.signedPreKey?.keyPair?.private &&
        raw?.signedPreKey?.keyPair?.public
    )
    const hasRegistrationMaterial = Boolean(
        Number.isInteger(raw?.registrationId) &&
        raw.registrationId >= 0 &&
        typeof raw?.advSecretKey === 'string' &&
        raw.advSecretKey.length > 0
    )
    const hasIdentity = Boolean(raw?.me?.id || raw?.me?.jid)
    const hasPairSuccessProof = Boolean(
        raw?.account?.details &&
        raw?.account?.accountSignature &&
        raw?.account?.accountSignatureKey &&
        raw?.account?.deviceSignature &&
        Array.isArray(raw?.signalIdentities) &&
        raw.signalIdentities.length > 0
    )
    return Boolean(hasKeys && hasRegistrationMaterial && hasIdentity && hasPairSuccessProof)
}

export function createLinkAttempt({ mode, timeoutMs, now = Date.now(), id = crypto.randomUUID() }) {
    const normalizedMode = normalizeConnectionMode(mode)
    const requestedLifetime = Number(timeoutMs)
    const lifetime = Number.isFinite(requestedLifetime) && requestedLifetime > 0
        ? Math.max(1000, requestedLifetime)
        : 2 * 60 * 1000
    return {
        id: String(id),
        mode: normalizedMode,
        phase: LINK_PHASES.STARTING,
        startedAt: Number(now),
        expiresAt: Number(now) + lifetime,
        credential: null,
        error: null,
        accepted: false
    }
}

export function publicLinkAttempt(attempt) {
    if (!attempt?.id || !attempt?.mode || !attempt?.phase) return null
    const snapshot = {
        id: String(attempt.id),
        mode: normalizeConnectionMode(attempt.mode),
        phase: String(attempt.phase),
        startedAt: Number(attempt.startedAt || 0),
        expiresAt: Number(attempt.expiresAt || 0),
        error: attempt.error?.message
            ? {
                code: String(attempt.error.code || 'link_failed'),
                message: String(attempt.error.message)
            }
            : null
    }
    if (attempt.phase === LINK_PHASES.AWAITING_QR && attempt.credential?.image) {
        snapshot.qr = { image: String(attempt.credential.image) }
    }
    if (attempt.phase === LINK_PHASES.AWAITING_CODE && attempt.credential?.code) {
        snapshot.pairingCode = String(attempt.credential.code)
    }
    return snapshot
}

export function createPairingCodeIssuer({ requestCode, flushWrites = async () => {} }) {
    if (typeof requestCode !== 'function') throw new TypeError('requestCode is required')
    let requestPromise = null
    let attempted = false

    return {
        get attempted() {
            return attempted
        },
        request(phone) {
            if (requestPromise) return requestPromise
            if (attempted) {
                return Promise.reject(codedError(
                    'PAIRING_CODE_ALREADY_REQUESTED',
                    'A phone code was already requested for this connection. Start a new attempt.'
                ))
            }
            attempted = true
            const normalizedPhone = validatePairingPhone(phone)
            requestPromise = (async () => {
                const issued = await requestCode(normalizedPhone)
                const code = normalizeIssuedPairingCode(issued)
                await flushWrites()
                return code
            })()
            return requestPromise
        }
    }
}

