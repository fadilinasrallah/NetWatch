export class PluginHostEventBridge {
    constructor({ maxQueue = 250, onDrop = null } = {}) {
        this.maxQueue = Math.max(1, Number(maxQueue || 250))
        this.onDrop = typeof onDrop === 'function' ? onDrop : null
        this.runtime = null
        this.ready = false
        this.discard = false
        this.queue = []
        this.dispatches = new Set()
    }

    setRuntime(runtime) {
        this.runtime = runtime || null
    }

    quiesce({ discard = false, clearQueue = false } = {}) {
        this.ready = false
        this.discard = Boolean(discard)
        if (clearQueue) this.queue = []
    }

    resumeQueueing() {
        this.discard = false
    }

    enqueue(event, payload) {
        if (this.queue.length >= this.maxQueue) {
            const dropped = this.queue.shift()
            try { this.onDrop?.(dropped) } catch {}
        }
        this.queue.push({ event, payload })
    }

    async emit(event, payload) {
        if (this.discard) return 0
        const runtime = this.runtime
        if (!this.ready || !runtime) {
            this.enqueue(event, payload)
            return 0
        }
        const dispatch = Promise.resolve().then(() => runtime.emitHostEvent(event, payload))
        this.dispatches.add(dispatch)
        try {
            return await dispatch
        } finally {
            this.dispatches.delete(dispatch)
        }
    }

    async drainDispatches() {
        while (this.dispatches.size) {
            await Promise.allSettled(Array.from(this.dispatches))
        }
    }

    async activate(runtime) {
        this.runtime = runtime
        this.discard = false
        while (this.runtime === runtime && this.queue.length) {
            const queued = this.queue.shift()
            await runtime.emitHostEvent(queued.event, queued.payload)
        }
        if (this.runtime === runtime) this.ready = true
    }

    clearRuntime(runtime = null) {
        if (!runtime || this.runtime === runtime) {
            this.runtime = null
            this.ready = false
        }
    }
}

