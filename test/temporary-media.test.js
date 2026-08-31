import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    createTemporaryMediaManager,
    sweepTemporaryMediaDirectory
} from '../src/core/temporary-media.js'

const createRoot = t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-media-cache-'))
    t.after(() => fs.rmSync(root, { force: true, recursive: true }))
    return root
}

test('startup sweep removes orphaned media while retaining the cache directory', t => {
    const root = createRoot(t)
    fs.writeFileSync(path.join(root, 'orphan.jpg'), 'orphan')
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'nested', 'orphan.mp4'), 'orphan')

    const manager = createTemporaryMediaManager(root)
    assert.equal(manager.startupSweep.removedFiles, 2)
    assert.equal(manager.startupSweep.removedDirectories, 1)
    assert.deepEqual(fs.readdirSync(root), [])
    assert.ok(fs.statSync(root).isDirectory())
})

test('leases are reference counted and delete media after the final consumer', t => {
    const root = createRoot(t)
    const manager = createTemporaryMediaManager(root)
    const mediaPath = path.join(root, 'shared.jpg')
    fs.writeFileSync(mediaPath, 'media')
    const first = manager.acquire(mediaPath)
    const second = manager.acquire(mediaPath)

    assert.equal(manager.activeLeaseCount, 2)
    assert.equal(first.release(), false)
    assert.ok(fs.existsSync(mediaPath))
    assert.equal(second.release(), true)
    assert.equal(fs.existsSync(mediaPath), false)
    assert.equal(second.release(), false)
    assert.equal(manager.activeLeaseCount, 0)
})

test('withFile releases temporary media even when the consumer throws', async t => {
    const root = createRoot(t)
    const manager = createTemporaryMediaManager(root)
    const mediaPath = path.join(root, 'failure.bin')
    fs.writeFileSync(mediaPath, 'media')

    await assert.rejects(
        manager.withFile(mediaPath, async filePath => {
            assert.equal(fs.readFileSync(filePath, 'utf8'), 'media')
            throw new Error('consumer failed')
        }),
        /consumer failed/u
    )
    assert.equal(fs.existsSync(mediaPath), false)
    assert.equal(manager.activeLeaseCount, 0)
})

test('failed producers remove partial downloads immediately', async t => {
    const root = createRoot(t)
    const manager = createTemporaryMediaManager(root)
    const mediaPath = path.join(root, 'partial.mp4')

    await assert.rejects(
        manager.produce(mediaPath, async target => {
            fs.writeFileSync(target, 'partial download')
            throw new Error('network failed')
        }),
        /network failed/u
    )
    assert.equal(fs.existsSync(mediaPath), false)
    assert.equal(manager.activeLeaseCount, 0)
})

test('consumers cannot lease a partially produced file', async t => {
    const root = createRoot(t)
    const manager = createTemporaryMediaManager(root)
    const mediaPath = path.join(root, 'in-progress.mp4')
    let finish
    const blocked = new Promise(resolve => { finish = resolve })
    const producing = manager.produce(mediaPath, async target => {
        fs.writeFileSync(target, 'partial')
        await blocked
        fs.appendFileSync(target, ' complete')
    })

    await new Promise(resolve => setImmediate(resolve))
    assert.throws(() => manager.acquire(mediaPath), { code: 'MEDIA_PATH_BUSY' })
    finish()
    const lease = await producing
    assert.equal(fs.readFileSync(lease.path, 'utf8'), 'partial complete')
    lease.release()
})

test('successful producers return a lease and reject missing or empty output', async t => {
    const root = createRoot(t)
    const manager = createTemporaryMediaManager(root)
    const mediaPath = path.join(root, 'complete.jpg')
    const lease = await manager.produce(mediaPath, target => fs.writeFileSync(target, 'complete'))
    assert.equal(fs.readFileSync(lease.path, 'utf8'), 'complete')
    assert.equal(lease.release(), true)

    await assert.rejects(
        manager.produce(path.join(root, 'missing.jpg'), async () => {}),
        { code: 'MEDIA_FILE_MISSING' }
    )
    await assert.rejects(
        manager.produce(path.join(root, 'empty.jpg'), target => fs.writeFileSync(target, '')),
        { code: 'EMPTY_MEDIA_FILE' }
    )
    assert.deepEqual(fs.readdirSync(root), [])
})

test('withProducedFile cleans up after producer and consumer success', async t => {
    const root = createRoot(t)
    const manager = createTemporaryMediaManager(root)
    const mediaPath = path.join(root, 'one-shot.bin')
    const result = await manager.withProducedFile(
        mediaPath,
        target => fs.writeFileSync(target, 'one shot'),
        target => fs.readFileSync(target, 'utf8')
    )
    assert.equal(result, 'one shot')
    assert.equal(fs.existsSync(mediaPath), false)
})

test('orphan sweep skips active leases and removes them after release', t => {
    const root = createRoot(t)
    const manager = createTemporaryMediaManager(root)
    const activePath = path.join(root, 'active.jpg')
    const orphanPath = path.join(root, 'orphan.jpg')
    fs.writeFileSync(activePath, 'active')
    fs.writeFileSync(orphanPath, 'orphan')
    const lease = manager.acquire(activePath)

    const result = manager.sweepOrphans()
    assert.equal(result.skippedActive, 1)
    assert.equal(fs.existsSync(activePath), true)
    assert.equal(fs.existsSync(orphanPath), false)
    lease.release()
    assert.equal(fs.existsSync(activePath), false)
})

test('managed cleanup rejects paths outside the cache and leaves them untouched', t => {
    const root = createRoot(t)
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.jpg`)
    fs.writeFileSync(outside, 'outside')
    t.after(() => { try { fs.unlinkSync(outside) } catch {} })
    const manager = createTemporaryMediaManager(root)

    assert.equal(manager.isManagedPath(outside), false)
    assert.throws(() => manager.acquire(outside), { code: 'UNMANAGED_MEDIA_PATH' })
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside')
    assert.throws(() => sweepTemporaryMediaDirectory(path.parse(root).root), {
        code: 'UNSAFE_MEDIA_CACHE_ROOT'
    })
})
