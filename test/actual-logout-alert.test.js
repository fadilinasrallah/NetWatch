import test from 'node:test'
import assert from 'node:assert/strict'
import {
    createActualLogoutAlertGate,
    isActualSessionLogout
} from '../src/core/actual-logout-alert.js'

test('classifies only an established session explicit 401 logout as actual logout', () => {
    const authenticated = { hadValidAuth: true }
    assert.equal(isActualSessionLogout({ ...authenticated, statusCode: 401 }), true)
    assert.equal(isActualSessionLogout({ ...authenticated, statusCode: 401, error: { message: 'Stream Errored (conflict)' } }), true)
    assert.equal(isActualSessionLogout({ ...authenticated, statusCode: 401, error: { message: 'restart required' } }), true)
    assert.equal(isActualSessionLogout({ ...authenticated, code: 401 }), true)
    assert.equal(isActualSessionLogout({ ...authenticated, output: { statusCode: 401 } }), true)
    assert.equal(isActualSessionLogout({ ...authenticated, error: { output: { statusCode: 401 } } }), true)
    assert.equal(isActualSessionLogout({
        ...authenticated,
        lastDisconnect: { error: { output: { statusCode: 401 } } }
    }), true)

    for (const statusCode of [408, 411, 428, 440, 500, 503, 515, null]) {
        assert.equal(isActualSessionLogout({ ...authenticated, statusCode }), false)
    }
    assert.equal(isActualSessionLogout({ ...authenticated, statusCode: 428, boomText: 'you were logged out' }), false)
    assert.equal(isActualSessionLogout({ ...authenticated, statusCode: 401, intentional: true }), false)
    assert.equal(isActualSessionLogout({ ...authenticated, statusCode: 401, linkAttemptActive: true }), false)
    assert.equal(isActualSessionLogout({ ...authenticated, statusCode: 401, connection: 'connecting' }), false)
    assert.equal(isActualSessionLogout({ statusCode: 401 }), false)
})

test('logout alert gate emits once until a successful connection resets it', () => {
    const gate = createActualLogoutAlertGate()
    assert.deepEqual(gate.onDisconnect({ statusCode: 408, everConnected: true }), {
        notify: false,
        reason: 'not-logged-out'
    })
    assert.deepEqual(gate.onDisconnect({ statusCode: 401, everConnected: true }), {
        notify: true,
        reason: 'logged-out',
        statusCode: 401
    })
    assert.deepEqual(gate.onDisconnect({ statusCode: 401, everConnected: true }), {
        notify: false,
        reason: 'already-notified'
    })
    assert.deepEqual(gate.snapshot(), { active: true })
    assert.equal(gate.onConnected(), true)
    assert.equal(gate.onConnected(), false)
    assert.equal(gate.onDisconnect({ statusCode: 401, everConnected: true }).notify, true)
})

test('logout alert gate can restore persisted idempotence state', () => {
    const restored = createActualLogoutAlertGate({ initiallyActive: true })
    assert.equal(restored.onDisconnect({ statusCode: 401, credentialsRegistered: true }).notify, false)
    restored.onConnected()
    assert.equal(restored.onDisconnect({ statusCode: 401, credentialsRegistered: true }).notify, true)
})

test('manual lifecycle events and ambiguous disconnect text can never become logout alerts', () => {
    const established = { connection: 'close', hadValidAuth: true, statusCode: '401' }
    assert.equal(isActualSessionLogout({ ...established, manualStop: true }), false)
    assert.equal(isActualSessionLogout({ ...established, suppressAlert: true }), false)
    assert.equal(isActualSessionLogout({ ...established, intentional: true }), false)
    assert.equal(isActualSessionLogout({ ...established, linkAttemptActive: true }), false)
    assert.equal(isActualSessionLogout({ ...established, connection: 'open' }), false)
    assert.equal(isActualSessionLogout({
        connection: 'close',
        hadValidAuth: true,
        statusCode: 408,
        error: { message: 'logged out' }
    }), false)
})

test('irrelevant disconnects do not clear idempotence and a custom terminal code is honored', () => {
    const gate = createActualLogoutAlertGate({ initiallyActive: true, loggedOutCode: 499 })
    assert.equal(gate.onDisconnect({ statusCode: 408, everConnected: true }).notify, false)
    assert.deepEqual(gate.snapshot(), { active: true })
    assert.equal(gate.onDisconnect({ statusCode: 499, everConnected: true }).notify, false)
    assert.equal(gate.onConnected(), true)
    assert.equal(gate.onDisconnect({ statusCode: '499', everConnected: true }).notify, true)
    assert.equal(gate.onDisconnect({ statusCode: 401, everConnected: true }).notify, false)
})

