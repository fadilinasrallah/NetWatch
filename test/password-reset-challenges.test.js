import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    GENERIC_PASSWORD_RESET_MESSAGE,
    createPasswordResetChallengeStore,
    loadOrCreatePasswordResetHmacSecret,
    toGenericPasswordResetResponse
} from '../src/core/password-reset-challenges.js'

const SECRET = 'test-only-secret-that-is-at-least-thirty-two-bytes-long'

function fixture(t, overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-reset-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    let timestamp = 1_800_000_000_000
    const statePath = path.join(root, 'password-reset-challenges.json')
    const store = createPasswordResetChallengeStore({
        statePath,
        hmacSecret: SECRET,
        now: () => timestamp,
        ...overrides
    })
    return {
        statePath,
        store,
        now: () => timestamp,
        advance: milliseconds => { timestamp += milliseconds }
    }
}

test('issues an opaque challenge and persists only the code HMAC', t => {
    const { store, statePath, now } = fixture(t, { randomInt: () => 1234 })
    const issued = store.issue({ subject: '15550000003', deliverable: true })

    assert.match(issued.challengeId, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(issued.delivery.code, '001234')
    assert.equal(issued.expiresAt, now() + 10 * 60 * 1000)
    assert.equal(issued.resendAfter, now() + 60 * 1000)
    assert.equal(Object.keys(issued).includes('delivery'), false)
    assert.doesNotMatch(JSON.stringify(issued), /001234|15550000003/)

    const raw = fs.readFileSync(statePath, 'utf8')
    assert.doesNotMatch(raw, /001234/)
    assert.doesNotMatch(raw, new RegExp(SECRET))
    const saved = JSON.parse(raw)
    const record = saved.challenges[issued.challengeId]
    assert.match(record.codeHmac, /^[a-f0-9]{64}$/)
    assert.equal('code' in record, false)
})

test('generic request response is identical in shape for deliverable and decoy challenges', t => {
    const { store, advance } = fixture(t)
    const real = store.issue({ subject: '15550000003', deliverable: true })
    advance(60_000)
    const decoy = store.issue({ subject: '15550000004', deliverable: false })
    const realResponse = toGenericPasswordResetResponse(real)
    const decoyResponse = toGenericPasswordResetResponse(decoy)

    assert.deepEqual(Object.keys(realResponse), Object.keys(decoyResponse))
    assert.equal(realResponse.message, GENERIC_PASSWORD_RESET_MESSAGE)
    assert.equal(decoyResponse.message, GENERIC_PASSWORD_RESET_MESSAGE)
    assert.equal(decoy.delivery, null)
    const stringFalse = store.issue({ subject: '15550000005', deliverable: 'false' })
    assert.equal(stringFalse.delivery, null)
    assert.doesNotMatch(JSON.stringify(realResponse), /15550000003/)
    assert.equal('delivery' in realResponse, false)
})

test('real and decoy requests have byte-equivalent public responses under identical public inputs', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-reset-equivalence-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const timestamp = 1_800_000_000_000
    const deterministicId = () => Buffer.alloc(32, 7)
    const options = {
        hmacSecret: SECRET,
        now: () => timestamp,
        randomBytes: deterministicId,
        randomInt: () => 123456
    }
    const realStore = createPasswordResetChallengeStore({
        ...options,
        statePath: path.join(root, 'real.json')
    })
    const decoyStore = createPasswordResetChallengeStore({
        ...options,
        statePath: path.join(root, 'decoy.json')
    })

    const real = toGenericPasswordResetResponse(realStore.issue({
        subject: '15550000003',
        deliverable: true
    }))
    const decoy = toGenericPasswordResetResponse(decoyStore.issue({
        subject: '15550000004',
        deliverable: false
    }))

    assert.equal(JSON.stringify(real), JSON.stringify(decoy))
})

test('cooldown and verification survive a process-style store recreation', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-reset-restart-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const statePath = path.join(root, 'challenges.json')
    const secretPath = path.join(root, 'reset-hmac.key')
    let timestamp = 1_800_000_000_000
    const stableSecret = loadOrCreatePasswordResetHmacSecret(secretPath)
    assert.equal(loadOrCreatePasswordResetHmacSecret(secretPath), stableSecret)
    assert.equal(Buffer.from(stableSecret, 'base64url').length, 32)

    const beforeRestart = createPasswordResetChallengeStore({
        statePath,
        hmacSecret: stableSecret,
        now: () => timestamp,
        randomInt: () => 246813
    })
    const issued = beforeRestart.issue({ subject: '15550000003', deliverable: true })

    const afterRestart = createPasswordResetChallengeStore({
        statePath,
        hmacSecret: loadOrCreatePasswordResetHmacSecret(secretPath),
        now: () => timestamp
    })
    assert.equal(afterRestart.issue({ subject: '15550000003', deliverable: true }).delivery, null)
    timestamp += 9 * 60 * 1000
    assert.equal(afterRestart.verify({ challengeId: issued.challengeId, code: '246813' }).ok, true)
})

test('same-process concurrent requests produce one deliverable challenge during cooldown', async t => {
    const { store, statePath } = fixture(t, { randomInt: () => 102030 })
    const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => (
        store.issue({ subject: '15550000003', deliverable: true })
    ))))
    assert.equal(results.filter(result => result.delivery).length, 1)
    assert.equal(new Set(results.map(result => result.challengeId)).size, 1)
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8')).challenges).length, 1)
})

test('bounds anonymous challenge state and evicts the oldest record', t => {
    let timestamp = 1_800_000_000_000
    const invalidations = []
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-reset-capacity-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const statePath = path.join(root, 'state.json')
    const store = createPasswordResetChallengeStore({
        statePath,
        hmacSecret: SECRET,
        maxChallenges: 2,
        now: () => timestamp,
        onInvalidated: event => invalidations.push(event)
    })
    const oldest = store.issue({ subject: 'one' })
    timestamp += 1
    store.issue({ subject: 'two' })
    timestamp += 1
    store.issue({ subject: 'three' })

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(Object.keys(saved.challenges).length, 2)
    assert.equal(Object.hasOwn(saved.challenges, oldest.challengeId), false)
    assert.equal(invalidations.some(event => event.reason === 'capacity-evicted'), true)
})

test('enforces resend cooldown and supersedes the old code after it', t => {
    let nextCode = 111111
    const invalidations = []
    const { store, advance } = fixture(t, {
        randomInt: () => nextCode,
        onInvalidated: event => invalidations.push(event)
    })
    const first = store.issue({ subject: '15550000003', deliverable: true })
    nextCode = 222222
    advance(59_999)
    const blocked = store.issue({ subject: '15550000003', deliverable: true })
    assert.equal(blocked.challengeId, first.challengeId)
    assert.equal(blocked.delivery, null)

    advance(1)
    const replacement = store.issue({ subject: '15550000003', deliverable: true })
    assert.notEqual(replacement.challengeId, first.challengeId)
    assert.equal(replacement.delivery.code, '222222')
    assert.equal(store.verify({ challengeId: first.challengeId, code: '111111' }).ok, false)
    assert.equal(store.verify({ challengeId: replacement.challengeId, code: '222222' }).ok, true)
    assert.equal(invalidations.some(event => event.reason === 'superseded'), true)
})

test('allows five attempts, consumes a successful challenge, and keeps the subject private', t => {
    const verifiedEvents = []
    const { store } = fixture(t, {
        randomInt: () => 876543,
        onVerified: event => verifiedEvents.push(event)
    })
    const first = store.issue({ subject: '15550000003', deliverable: true })
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        const result = store.verify({ challengeId: first.challengeId, code: '000000' })
        assert.equal(result.ok, false)
        assert.equal(result.attemptsRemaining, 5 - attempt)
    }
    const success = store.verify({ challengeId: first.challengeId, code: '876543' })
    assert.equal(success.ok, true)
    assert.equal(success.subject, '15550000003')
    assert.deepEqual(JSON.parse(JSON.stringify(success)), { ok: true, status: 'verified' })
    assert.equal(store.verify({ challengeId: first.challengeId, code: '876543' }).ok, false)
    assert.deepEqual(verifiedEvents, [{ challengeId: first.challengeId, subject: '15550000003' }])

    const second = store.issue({ subject: '15550000004', deliverable: true })
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = store.verify({ challengeId: second.challengeId, code: 'bad-code' })
        assert.equal(result.ok, false)
        assert.equal(result.attemptsRemaining, 5 - attempt)
    }
    assert.equal(store.verify({ challengeId: second.challengeId, code: second.delivery.code }).ok, false)
})

test('verify-and-commit preserves a valid code when the password commit throws', t => {
    const { store } = fixture(t, { randomInt: () => 314159 })
    const issued = store.issue({ subject: '15550000003', deliverable: true })
    let calls = 0

    assert.throws(
        () => store.verifyAndCommit({ challengeId: issued.challengeId, code: issued.delivery.code }, () => {
            calls += 1
            throw new Error('simulated config write failure')
        }),
        /simulated config write failure/u
    )
    assert.equal(calls, 1)

    const recovered = store.verifyAndCommit(
        { challengeId: issued.challengeId, code: issued.delivery.code },
        subject => {
            calls += 1
            assert.equal(subject, '15550000003')
        }
    )
    assert.equal(recovered.ok, true)
    assert.equal(calls, 2)
    assert.equal(store.verify({ challengeId: issued.challengeId, code: issued.delivery.code }).ok, false)
})

test('verify-and-commit remains valid when the commit invalidates all subject challenges', t => {
    const { store } = fixture(t, { randomInt: () => 271828 })
    const issued = store.issue({ subject: '15550000003', deliverable: true })

    const result = store.verifyAndCommit(
        { challengeId: issued.challengeId, code: issued.delivery.code },
        subject => assert.equal(store.invalidateSubject(subject, 'password-changed'), 1)
    )
    assert.equal(result.ok, true)
    assert.equal(store.verify({ challengeId: issued.challengeId, code: issued.delivery.code }).ok, false)
})

test('expires at ten minutes and supports subject invalidation and a full reset hook', t => {
    const invalidations = []
    const resets = []
    const { store, advance } = fixture(t, {
        randomInt: () => 135724,
        onInvalidated: event => invalidations.push(event),
        onReset: event => resets.push(event)
    })
    const expired = store.issue({ subject: '15550000003', deliverable: true })
    advance(10 * 60 * 1000)
    assert.equal(store.verify({ challengeId: expired.challengeId, code: '135724' }).ok, false)
    assert.equal(invalidations.some(event => event.reason === 'expired'), true)

    store.issue({ subject: 'one', deliverable: true })
    advance(60_000)
    store.issue({ subject: 'two', deliverable: true })
    assert.equal(store.invalidateSubject('one', 'password-changed'), 1)
    assert.equal(store.resetState('tests'), 1)
    assert.deepEqual(resets, [{ reason: 'tests', removed: 1 }])
})

test('refuses weak secrets and corrupt state rather than overwriting it', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-reset-corrupt-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const statePath = path.join(root, 'state.json')

    assert.throws(() => createPasswordResetChallengeStore({
        statePath,
        hmacSecret: 'weak'
    }), error => error?.code === 'RESET_SECRET_INVALID')

    fs.writeFileSync(statePath, '{ broken')
    const store = createPasswordResetChallengeStore({ statePath, hmacSecret: SECRET })
    assert.throws(() => store.issue({ subject: '15550000003' }), error => error?.code === 'RESET_STATE_CORRUPT')
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{ broken')

    const secretPath = path.join(root, 'invalid-secret.key')
    fs.writeFileSync(secretPath, 'not-a-valid-key')
    assert.throws(
        () => loadOrCreatePasswordResetHmacSecret(secretPath),
        error => error?.code === 'RESET_SECRET_FILE_INVALID'
    )
})
