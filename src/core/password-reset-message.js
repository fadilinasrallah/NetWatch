const SIX_DIGIT_CODE = /^\d{6}$/u

export function buildPasswordResetWhatsAppMessage({ code, expiresInMinutes = 10 } = {}) {
    const verificationCode = String(code || '').trim()
    if (!SIX_DIGIT_CODE.test(verificationCode)) {
        throw new TypeError('A six-digit password verification code is required.')
    }

    const minutes = Number(expiresInMinutes)
    if (!Number.isInteger(minutes) || minutes < 1) {
        throw new TypeError('Password verification expiry must be a positive number of minutes.')
    }

    const minuteLabel = minutes === 1 ? 'minute' : 'minutes'
    return [
        '*NetWatch password change*',
        '',
        'Use this verification code to continue:',
        '',
        `*${verificationCode}*`,
        '',
        `This code expires in ${minutes} ${minuteLabel} and can only be used once. Do not share it with anyone.`,
        '',
        'If you did not request this change, ignore this message. Your password will remain unchanged.'
    ].join('\n')
}
