import test from 'node:test'
import assert from 'node:assert/strict'
import {
    listNotificationGroupChoices,
    normalizeNotificationGroupJid,
    validateSoloNotificationGroup
} from '../src/core/notification-group.js'

const sock = {
    signalRepository: {
        lidMapping: {
            async getPNForLID(jid) {
                return ({
                    'owner@lid': '15550000003@s.whatsapp.net',
                    'other@lid': '15550000002@s.whatsapp.net'
                })[jid] || null
            }
        }
    }
}

test('normalizes only WhatsApp group identifiers', () => {
    assert.equal(normalizeNotificationGroupJid(' 123@g.us '), '123@g.us')
    assert.equal(normalizeNotificationGroupJid('123@s.whatsapp.net'), null)
})

test('lists groups without checking membership until explicit confirmation', () => {
    assert.deepEqual(listNotificationGroupChoices({
        a: { id: '2@g.us', subject: 'Zulu', participants: [{}] },
        b: { id: '1@g.us', subject: 'Alpha', participants: [{}, {}] }
    }), [
        { id: '1@g.us', name: 'Alpha', participantCount: 2 },
        { id: '2@g.us', name: 'Zulu', participantCount: 1 }
    ])
})

test('accepts a group containing only the session owner across LID and hosted PN shapes', async () => {
    const lid = await validateSoloNotificationGroup({
        sock,
        ownerPhone: '15550000003',
        metadata: { id: '1@g.us', subject: 'Private', participants: [{ id: 'owner@lid' }] }
    })
    assert.equal(lid.ok, true)

    const hosted = await validateSoloNotificationGroup({
        sock,
        ownerPhone: '15550000003',
        metadata: { id: '2@g.us', subject: 'Private', participants: [{ phoneNumber: '15550000003@hosted' }] }
    })
    assert.equal(hosted.ok, true)

    const knownOwnerLid = await validateSoloNotificationGroup({
        sock: { signalRepository: { lidMapping: {} } },
        ownerPhone: '15550000003',
        ownerJids: ['known-owner@lid'],
        metadata: { id: '3@g.us', subject: 'Private', participants: [{ id: 'known-owner@lid' }] }
    })
    assert.equal(knownOwnerLid.ok, true)
})

test('rejects groups with another or unresolved participant', async () => {
    const shared = await validateSoloNotificationGroup({
        sock,
        ownerPhone: '15550000003',
        metadata: { id: '1@g.us', subject: 'Shared', participants: [{ id: 'owner@lid' }, { id: 'other@lid' }] }
    })
    assert.equal(shared.ok, false)
    assert.equal(shared.reason, 'not_solo')

    const unresolved = await validateSoloNotificationGroup({
        sock,
        ownerPhone: '15550000003',
        metadata: { id: '2@g.us', subject: 'Unknown', participants: [{ id: 'missing@lid' }] }
    })
    assert.equal(unresolved.ok, false)
})

