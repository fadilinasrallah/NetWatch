function digitsOnly(value) {
    return String(value || '').replace(/\D/gu, '')
}

export function normalizeNotificationGroupJid(value) {
    const raw = String(value || '').trim().toLowerCase()
    return /^\d+@g\.us$/u.test(raw) ? raw : null
}

function canonicalUserJid(value) {
    const raw = String(value || '').trim().toLowerCase()
    if (!raw) return null
    if (raw.endsWith('@hosted.lid')) return `${raw.slice(0, -'@hosted.lid'.length)}@lid`
    if (raw.endsWith('@hosted')) return `${raw.slice(0, -'@hosted'.length)}@s.whatsapp.net`
    return raw
}

function phoneFromJid(value) {
    const jid = canonicalUserJid(value)
    if (!jid?.endsWith('@s.whatsapp.net')) return null
    return digitsOnly(jid.split('@')[0].split(':')[0]) || null
}

function participantCandidates(participant) {
    if (typeof participant === 'string') return [participant]
    if (!participant || typeof participant !== 'object') return []
    return [participant.phoneNumber, participant.phone_number, participant.pn, participant.id, participant.jid, participant.lid]
        .filter(Boolean)
        .map(canonicalUserJid)
        .filter(Boolean)
}

async function resolveParticipantPhone(sock, participant, owner = null, ownerJids = new Set()) {
    const candidates = participantCandidates(participant)
    if (owner && candidates.some(candidate => ownerJids.has(candidate))) return owner
    for (const candidate of candidates) {
        const phone = phoneFromJid(candidate)
        if (phone) return phone
    }
    const mapping = sock?.signalRepository?.lidMapping
    if (typeof mapping?.getPNForLID !== 'function') return null
    for (const candidate of candidates) {
        if (!candidate.endsWith('@lid')) continue
        try {
            const phone = phoneFromJid(await mapping.getPNForLID(candidate))
            if (phone) return phone
        } catch {}
    }
    return null
}

function publicGroup(metadata) {
    const id = normalizeNotificationGroupJid(metadata?.id)
    if (!id) return null
    return {
        id,
        name: String(metadata?.subject || 'Unnamed group').trim() || 'Unnamed group',
        participantCount: Array.isArray(metadata?.participants) ? metadata.participants.length : null
    }
}

export function listNotificationGroupChoices(groups) {
    return (Array.isArray(groups) ? groups : Object.values(groups || {}))
        .map(publicGroup)
        .filter(Boolean)
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

export async function validateSoloNotificationGroup({ sock, metadata, ownerPhone, ownerJids = [] }) {
    const owner = digitsOnly(ownerPhone)
    const group = publicGroup(metadata)
    if (!owner || !group) return { ok: false, reason: 'invalid_group', group: null }

    const participants = Array.isArray(metadata?.participants) ? metadata.participants : []
    if (!participants.length) return { ok: false, reason: 'not_solo', group }

    const normalizedOwnerJids = new Set((Array.isArray(ownerJids) ? ownerJids : [ownerJids])
        .map(canonicalUserJid)
        .filter(Boolean))
    const resolved = new Set()
    let unresolved = 0
    for (const participant of participants) {
        const phone = await resolveParticipantPhone(sock, participant, owner, normalizedOwnerJids)
        if (phone) resolved.add(phone)
        else unresolved += 1
    }

    if (unresolved || resolved.size !== 1 || !resolved.has(owner)) {
        return { ok: false, reason: 'not_solo', group }
    }
    return { ok: true, reason: 'solo', group }
}

