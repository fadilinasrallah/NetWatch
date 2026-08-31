import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPasswordResetWhatsAppMessage } from '../src/core/password-reset-message.js'

test('builds a polished password-change message with the six-digit code and security guidance', () => {
    const message = buildPasswordResetWhatsAppMessage({ code: '001234' })

    assert.equal(message, [
        '*NetWatch password change*',
        '',
        'Use this verification code to continue:',
        '',
        '*001234*',
        '',
        'This code expires in 10 minutes and can only be used once. Do not share it with anyone.',
        '',
        'If you did not request this change, ignore this message. Your password will remain unchanged.'
    ].join('\n'))
    assert.doesNotMatch(message, /reset code|emoji/iu)
    assert.equal(/[^\x00-\x7F]/u.test(message), false)
})

test('rejects malformed verification codes instead of sending ambiguous reset messages', () => {
    for (const code of ['', '12345', '1234567', '12 3456', 'abcdef']) {
        assert.throws(
            () => buildPasswordResetWhatsAppMessage({ code }),
            /six-digit password verification code/u
        )
    }
})

test('formats a custom singular expiry without weakening the one-time-code warning', () => {
    const message = buildPasswordResetWhatsAppMessage({ code: '654321', expiresInMinutes: 1 })

    assert.match(message, /expires in 1 minute and can only be used once/u)
    assert.match(message, /Do not share it with anyone/u)
    assert.match(message, /Your password will remain unchanged/u)
})
