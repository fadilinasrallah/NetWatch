import test from 'node:test'
import assert from 'node:assert/strict'
import { PluginHostEventBridge } from '../src/core/plugin-host-event-bridge.js'

function fakeRuntime(name, deliveries, block = null) {
    return {
        async emitHostEvent(event, payload) {
            if (block) await block
            deliveries.push({ name, event, payload })
            return 1
        }
    }
}

test('event arriving while a new runtime reconciles is flushed once on activation', async () => {
    const deliveries = []
    const bridge = new PluginHostEventBridge()
    const runtime = fakeRuntime('new', deliveries)
    bridge.quiesce()
    bridge.setRuntime(runtime)

    await bridge.emit('viewonce.persisted', { id: 'during-reconcile' })
    assert.equal(deliveries.length, 0)
    await bridge.activate(runtime)
    assert.deepEqual(deliveries.map(item => item.payload.id), ['during-reconcile'])
})

test('event arriving during an old-runtime drain reaches only the new runtime', async () => {
    const deliveries = []
    let release
    const blocked = new Promise(resolve => { release = resolve })
    const oldRuntime = fakeRuntime('old', deliveries, blocked)
    const newRuntime = fakeRuntime('new', deliveries)
    const bridge = new PluginHostEventBridge()
    bridge.setRuntime(oldRuntime)
    await bridge.activate(oldRuntime)

    const oldDispatch = bridge.emit('viewonce.persisted', { id: 'old' })
    bridge.quiesce()
    const draining = bridge.drainDispatches()
    await bridge.emit('viewonce.persisted', { id: 'during-drain' })
    release()
    await Promise.all([oldDispatch, draining])

    bridge.setRuntime(newRuntime)
    await bridge.activate(newRuntime)
    assert.deepEqual(deliveries, [
        { name: 'old', event: 'viewonce.persisted', payload: { id: 'old' } },
        { name: 'new', event: 'viewonce.persisted', payload: { id: 'during-drain' } }
    ])
})

test('discard mode prevents late events after termination', async () => {
    const bridge = new PluginHostEventBridge()
    bridge.quiesce({ discard: true, clearQueue: true })
    assert.equal(await bridge.emit('viewonce.persisted', { id: 'late' }), 0)
    assert.equal(bridge.queue.length, 0)
})

