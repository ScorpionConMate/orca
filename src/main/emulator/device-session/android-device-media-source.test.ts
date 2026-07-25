import { describe, expect, it } from 'vitest'
import { AndroidDeviceMediaSource } from './android-device-media-source'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'
import type { DeviceMediaEvent } from '../../../shared/device-session-types'

function frame(opts: {
  config?: boolean
  keyFrame?: boolean
  pts?: string
}): {
  config: boolean
  keyFrame: boolean
  pts: string
  bytes: ArrayBuffer
} {
  return {
    config: opts.config ?? false,
    keyFrame: opts.keyFrame ?? !opts.config,
    pts: opts.pts ?? '0',
    bytes: new ArrayBuffer(2)
  }
}

describe('AndroidDeviceMediaSource', () => {
  it('re-emits metadata events from the registry', () => {
    scrcpyVideoRegistry.register('test-meta', () => {})
    scrcpyVideoRegistry.pushMeta('test-meta', { codecId: 'h264', width: 1280, height: 720 })

    const source = new AndroidDeviceMediaSource('test-meta')
    const events: DeviceMediaEvent[] = []
    source.subscribe((event) => events.push(event))

    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.type).toBe('metadata')
    if (ev.type === 'metadata') {
      expect(ev.codec).toBe('h264')
      expect(ev.width).toBe(1280)
      expect(ev.height).toBe(720)
    }

    scrcpyVideoRegistry.stop('test-meta')
  })

  it('re-emits config frames as config events', () => {
    scrcpyVideoRegistry.register('test-config', () => {})
    const source = new AndroidDeviceMediaSource('test-config')
    const events: DeviceMediaEvent[] = []
    source.subscribe((event) => events.push(event))

    scrcpyVideoRegistry.pushFrame('test-config', frame({ config: true }))

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('config')

    scrcpyVideoRegistry.stop('test-config')
  })

  it('re-emits data frames with seq, pts, keyFrame, bytes', () => {
    scrcpyVideoRegistry.register('test-frame', () => {})
    const source = new AndroidDeviceMediaSource('test-frame')
    const events: DeviceMediaEvent[] = []
    source.subscribe((event) => events.push(event))

    scrcpyVideoRegistry.pushFrame(
      'test-frame',
      frame({ keyFrame: true, pts: '42' })
    )

    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.type).toBe('frame')
    if (ev.type === 'frame') {
      expect(ev.keyFrame).toBe(true)
      expect(ev.pts).toBe(42n)
      expect(ev.seq).toBe(0)
      expect(ev.bytes.byteLength).toBe(2)
    }

    scrcpyVideoRegistry.stop('test-frame')
  })

  it('assigns monotonically increasing seq to each frame', () => {
    scrcpyVideoRegistry.register('test-seq', () => {})
    const source = new AndroidDeviceMediaSource('test-seq')
    const events: DeviceMediaEvent[] = []
    source.subscribe((event) => events.push(event))

    scrcpyVideoRegistry.pushFrame('test-seq', frame({ pts: '1' }))
    scrcpyVideoRegistry.pushFrame('test-seq', frame({ pts: '2' }))
    scrcpyVideoRegistry.pushFrame('test-seq', frame({ config: true }))
    scrcpyVideoRegistry.pushFrame('test-seq', frame({ pts: '3' }))

    const frameEvents = events.filter((e): e is DeviceMediaEvent & { type: 'frame' } => e.type === 'frame')
    expect(frameEvents.map((e) => e.seq)).toEqual([0, 1, 2])

    scrcpyVideoRegistry.stop('test-seq')
  })

  it('unsubscribe prevents further events', () => {
    scrcpyVideoRegistry.register('test-unsub', () => {})
    const source = new AndroidDeviceMediaSource('test-unsub')
    const events: DeviceMediaEvent[] = []
    const unsubscribe = source.subscribe((event) => events.push(event))

    scrcpyVideoRegistry.pushFrame('test-unsub', frame({}))
    expect(events).toHaveLength(1)

    unsubscribe()
    scrcpyVideoRegistry.pushFrame('test-unsub', frame({}))
    expect(events).toHaveLength(1) // no delivery after unsubscribe

    scrcpyVideoRegistry.stop('test-unsub')
  })

  it('maps h264 codecId to h264 codec', () => {
    scrcpyVideoRegistry.register('test-codec', () => {})
    scrcpyVideoRegistry.pushMeta('test-codec', { codecId: 'h264', width: 1, height: 1 })

    const source = new AndroidDeviceMediaSource('test-codec')
    const events: DeviceMediaEvent[] = []
    source.subscribe((event) => events.push(event))

    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.type).toBe('metadata')
    if (ev.type === 'metadata') {
      expect(ev.codec).toBe('h264')
    }

    scrcpyVideoRegistry.stop('test-codec')
  })

  it('falls back to h264 for unknown codecId', () => {
    scrcpyVideoRegistry.register('test-unknown-codec', () => {})
    scrcpyVideoRegistry.pushMeta('test-unknown-codec', { codecId: 'hevc', width: 1, height: 1 })

    const source = new AndroidDeviceMediaSource('test-unknown-codec')
    const events: DeviceMediaEvent[] = []
    source.subscribe((event) => events.push(event))

    const ev = events[0]
    expect(ev.type).toBe('metadata')
    if (ev.type === 'metadata') {
      expect(ev.codec).toBe('h264')
    }

    scrcpyVideoRegistry.stop('test-unknown-codec')
  })

  it('re-emits events in registry order (meta, config, frame, frame)', () => {
    scrcpyVideoRegistry.register('test-order', () => {})
    scrcpyVideoRegistry.pushMeta('test-order', { codecId: 'h264', width: 800, height: 600 })

    const source = new AndroidDeviceMediaSource('test-order')
    const events: DeviceMediaEvent[] = []
    source.subscribe((event) => events.push(event))

    // Should replay cached meta first, then live events
    scrcpyVideoRegistry.pushFrame('test-order', frame({ config: true }))
    scrcpyVideoRegistry.pushFrame('test-order', frame({ keyFrame: true, pts: '1' }))
    scrcpyVideoRegistry.pushFrame('test-order', frame({ pts: '2' }))

    expect(events.map((e) => e.type)).toEqual(['metadata', 'config', 'frame', 'frame'])

    scrcpyVideoRegistry.stop('test-order')
  })

  it('replays cached meta + config + GOP on subscribe', () => {
    scrcpyVideoRegistry.register('test-gop-replay', () => {})
    // Push data before subscribing — the registry caches meta, config, and GOP.
    scrcpyVideoRegistry.pushMeta('test-gop-replay', { codecId: 'h264', width: 640, height: 480 })
    scrcpyVideoRegistry.pushFrame('test-gop-replay', frame({ config: true, pts: '10' }))
    scrcpyVideoRegistry.pushFrame('test-gop-replay', frame({ config: false, keyFrame: true, pts: '100' }))
    scrcpyVideoRegistry.pushFrame('test-gop-replay', frame({ config: false, keyFrame: false, pts: '101' }))

    const source = new AndroidDeviceMediaSource('test-gop-replay')
    const events: DeviceMediaEvent[] = []
    source.subscribe((event) => events.push(event))

    expect(events).toHaveLength(4)
    expect(events.map((e) => e.type)).toEqual(['metadata', 'config', 'frame', 'frame'])

    // Verify pts is piped correctly through both config and frame events
    const configEv = events[1]
    expect(configEv.type).toBe('config')
    if (configEv.type === 'config') {
      expect(configEv.pts).toBe(10n)
    }
    const frameEv = events[2]
    expect(frameEv.type).toBe('frame')
    if (frameEv.type === 'frame') {
      expect(frameEv.pts).toBe(100n)
      expect(frameEv.keyFrame).toBe(true)
    }

    scrcpyVideoRegistry.stop('test-gop-replay')
  })
})
