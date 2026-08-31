const DEFAULT_LOGGED_OUT_CODE = 401

function disconnectCode(event) {
    const candidates = [
        event?.statusCode,
        event?.code,
        event?.output?.statusCode,
        event?.error?.output?.statusCode,
        event?.error?.statusCode,
        event?.lastDisconnect?.error?.output?.statusCode,
        event?.lastDisconnect?.error?.statusCode
    ]
    for (const value of candidates) {
        if (value === null || value === undefined || value === '') continue
        const numeric = Number(value)
        if (Number.isFinite(numeric)) return numeric
    }
    return null
}

function hadAuthenticatedSession(event) {
    return event?.everConnected === true ||
        event?.hadValidAuth === true ||
        event?.wasAuthenticated === true ||
        event?.credentialsRegistered === true
}

/**
 * Only an explicit WhatsApp logged-out status is terminal here. Connection
 * loss, timeouts, restart requests, conflicts, and text that merely contains
 * "logged out" must not notify the user.
 */
export function isActualSessionLogout(event, { loggedOutCode = DEFAULT_LOGGED_OUT_CODE } = {}) {
    if (!event || event.connection && event.connection !== 'close') return false
    if (event.intentional || event.linkAttemptActive || event.manualStop || event.suppressAlert) return false
    if (!hadAuthenticatedSession(event)) return false
    return disconnectCode(event) === Number(loggedOutCode)
}

export function createActualLogoutAlertGate({
    initiallyActive = false,
    loggedOutCode = DEFAULT_LOGGED_OUT_CODE
} = {}) {
    let active = Boolean(initiallyActive)

    return Object.freeze({
        get active() {
            return active
        },
        onDisconnect(event) {
            if (!isActualSessionLogout(event, { loggedOutCode })) {
                return { notify: false, reason: 'not-logged-out' }
            }
            if (active) return { notify: false, reason: 'already-notified' }
            active = true
            return {
                notify: true,
                reason: 'logged-out',
                statusCode: disconnectCode(event)
            }
        },
        onConnected() {
            const changed = active
            active = false
            return changed
        },
        snapshot() {
            return { active }
        }
    })
}

