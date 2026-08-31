import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as lifecycle from '../src/core/session-lifecycle.js'

const {
    createLifecycleGate,
    resetAuthDirectoryStrict,
    writeJsonAtomicStrict
} = lifecycle

test('lifecycle gate rejects overlapping session actions', async () => {
    const gate = createLifecycleGate()
    let release
    const blocked = new Promise(resolve => { release = resolve })
    const first = gate.run('reconnect', async token => {
        assert.equal(token.name, 'reconnect')
        return blocked
    })
    await assert.rejects(
        () => gate.run('terminate', async () => {}),
        error => error?.code === 'SESSION_BUSY'
    )
    release()
    await first
    assert.equal(gate.active, null)
})

test('lifecycle gate is released when an action fails', async () => {
    const gate = createLifecycleGate()
    await assert.rejects(
        () => gate.run('reconnect', async () => { throw new Error('failed') }),
        /failed/u
    )
    assert.equal(gate.active, null)
    assert.equal(await gate.run('retry', async () => 'ok'), 'ok')
})

test('strict auth reset only empties the exact real auth child', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-lifecycle-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const auth = path.join(root, 'auth')
    fs.mkdirSync(auth)
    fs.writeFileSync(path.join(auth, 'creds.json'), '{}')

    resetAuthDirectoryStrict(root, auth)
    assert.deepEqual(fs.readdirSync(auth), [])
    assert.throws(
        () => resetAuthDirectoryStrict(root, path.join(root, 'other')),
        /unexpected authentication path/u
    )
})

test('strict auth reset refuses a symbolic-link auth path', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-lifecycle-link-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-lifecycle-outside-'))
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true })
        fs.rmSync(outside, { recursive: true, force: true })
    })
    const auth = path.join(root, 'auth')
    try {
        fs.symlinkSync(outside, auth, 'junction')
    } catch (error) {
        if (error?.code === 'EPERM') return
        throw error
    }
    assert.throws(() => resetAuthDirectoryStrict(root, auth), /must be a real directory/u)
})

test('atomic JSON writes replace the target and leave no temporary file', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-json-write-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const configPath = path.join(root, 'nested', 'bot.json')

    writeJsonAtomicStrict(configPath, { passwordHash: 'first', keep: true })
    writeJsonAtomicStrict(configPath, { passwordHash: 'second', keep: true })

    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
        passwordHash: 'second',
        keep: true
    })
    assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['bot.json'])
})

test('obsolete desktop-upgrade lifecycle APIs are removed', () => {
    assert.equal('performAndroidRelink' in lifecycle, false)
    assert.equal('persistCompanionProfileStrict' in lifecycle, false)
})
