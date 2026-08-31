import test from 'node:test'
import assert from 'node:assert/strict'
import {
    LINK_PHASES,
    authCredentialsAreComplete,
    createLinkAttempt,
    createPairingCodeIssuer,
    normalizeConnectionMode,
    normalizeIssuedPairingCode,
    publicLinkAttempt,
    validatePairingPhone
} from '../src/core/connection-pairing.js'

const validCreds = registered => ({
    registered,
    registrationId: 7,
    advSecretKey: 'secret',
    me: { id: '15550000001@s.whatsapp.net' },
    noiseKey: { private: 'a', public: 'b' },
    pairingEphemeralKeyPair: { private: 'c', public: 'd' },
    signedIdentityKey: { private: 'e', public: 'f' },
    signedPreKey: { keyPair: { private: 'g', public: 'h' } },
    account: {
        details: 'details',
        accountSignature: 'account-signature',
        accountSignatureKey: 'account-signature-key',
        deviceSignature: 'device-signature'
    },
    signalIdentities: [{ identifier: { name: 'owner' } }],
    platform: 'android'
})

test('connection mode accepts QR and phone code only', () => {
    assert.equal(normalizeConnectionMode(), 'qr')
    assert.equal(normalizeConnectionMode('QR'), 'qr')
    assert.equal(normalizeConnectionMode('code'), 'code')
    assert.throws(() => normalizeConnectionMode('pairing'), error => error?.code === 'INVALID_CONNECTION_MODE')
})

test('phone-code input requires international ASCII digits', () => {
    assert.equal(validatePairingPhone('15550000001'), '15550000001')
    for (const invalid of ['0555000000', '+15550000001', '212 665 644 666', '1234567', '1'.repeat(16)]) {
        assert.throws(() => validatePairingPhone(invalid), error => error?.code === 'INVALID_PAIRING_PHONE')
    }
})

test('half-paired credentials are never treated as a saved session', () => {
    const complete = validCreds(false)
    assert.equal(authCredentialsAreComplete(complete), true)
    assert.equal(authCredentialsAreComplete({ ...complete, registered: undefined }), true)
    assert.equal(authCredentialsAreComplete({ ...complete, account: undefined, registered: true }), false)
    assert.equal(authCredentialsAreComplete({ ...complete, signalIdentities: [], registered: true }), false)
})

test('QR-linked credentials stay valid even though Baileys leaves registered false', () => {
    const qrLinked = validCreds(false)
    assert.equal(authCredentialsAreComplete(qrLinked), true)
})

test('phone-code companion-finish state is incomplete until pair-success material exists', () => {
    const companionFinishOnly = {
        ...validCreds(true),
        me: { id: '15550000001@s.whatsapp.net', name: '~' },
        account: undefined,
        signalIdentities: [],
        platform: undefined,
        pairingCode: '1234ABCD'
    }
    assert.equal(authCredentialsAreComplete(companionFinishOnly), false)
})

test('pairing code validation uses the complete Baileys Crockford alphabet', () => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTVWXYZ'
    for (const character of alphabet) {
        assert.equal(normalizeIssuedPairingCode(character.repeat(8)), character.repeat(8))
        if (/[A-Z]/u.test(character)) {
            assert.equal(
                normalizeIssuedPairingCode(character.toLowerCase().repeat(8)),
                character.repeat(8)
            )
        }
    }
    assert.equal(normalizeIssuedPairingCode('LLLLLLLL'), 'LLLLLLLL')

    const excludedAlphaNumerics = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ']
        .filter(character => !alphabet.includes(character))
    for (const character of excludedAlphaNumerics) {
        assert.throws(
            () => normalizeIssuedPairingCode(character.repeat(8)),
            error => error?.code === 'INVALID_PAIRING_CODE'
        )
    }
    for (const invalid of ['', '1234567', '123456789', 'abcd efgh', '1234-ABC', '１２３４ABCD']) {
        assert.throws(() => normalizeIssuedPairingCode(invalid), error => error?.code === 'INVALID_PAIRING_CODE')
    }
})

test('pairing code issuer performs one request and flushes before publishing', async () => {
    const calls = []
    let release
    const gate = new Promise(resolve => { release = resolve })
    const issuer = createPairingCodeIssuer({
        requestCode: async phone => {
            calls.push(`request:${phone}`)
            await gate
            return '1234ABCD'
        },
        flushWrites: async () => { calls.push('flush') }
    })

    const first = issuer.request('15550000001')
    const duplicate = issuer.request('15550000001')
    assert.strictEqual(first, duplicate)
    release()
    assert.equal(await first, '1234ABCD')
    assert.deepEqual(calls, ['request:15550000001', 'flush'])
    assert.equal(await duplicate, '1234ABCD')
    assert.equal(await issuer.request('15550000001'), '1234ABCD')
    assert.deepEqual(calls, ['request:15550000001', 'flush'])
})

test('pairing code issuer never publishes or flushes a malformed upstream code', async () => {
    let flushes = 0
    const issuer = createPairingCodeIssuer({
        requestCode: async () => 'ABCD-IJK',
        flushWrites: async () => { flushes += 1 }
    })
    await assert.rejects(
        () => issuer.request('15550000001'),
        error => error?.code === 'INVALID_PAIRING_CODE'
    )
    assert.equal(flushes, 0)
})

test('failed phone-code request cannot overwrite its attempt with a second code', async () => {
    let calls = 0
    const issuer = createPairingCodeIssuer({
        requestCode: async () => {
            calls += 1
            throw new Error('network')
        }
    })
    await assert.rejects(() => issuer.request('15550000001'), /network/u)
    await assert.rejects(() => issuer.request('15550000001'), /network/u)
    assert.equal(calls, 1)
})

test('public link attempt exposes only the credential for its active phase', () => {
    const attempt = createLinkAttempt({ mode: 'code', timeoutMs: 120000, now: 1000, id: 'attempt-1' })
    assert.equal(attempt.phase, LINK_PHASES.STARTING)
    assert.deepEqual(publicLinkAttempt(attempt), {
        id: 'attempt-1',
        mode: 'code',
        phase: 'starting',
        startedAt: 1000,
        expiresAt: 121000,
        error: null
    })

    attempt.phase = LINK_PHASES.AWAITING_CODE
    attempt.credential = { code: '1234ABCD', hidden: 'ignored' }
    assert.equal(publicLinkAttempt(attempt).pairingCode, '1234ABCD')
    attempt.phase = LINK_PHASES.ERROR
    attempt.error = { code: 'failed', message: 'Try again' }
    assert.equal(publicLinkAttempt(attempt).pairingCode, undefined)
    assert.deepEqual(publicLinkAttempt(attempt).error, { code: 'failed', message: 'Try again' })
})

