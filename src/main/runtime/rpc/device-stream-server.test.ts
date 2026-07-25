import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  DeviceStreamOpcode, encodeDeviceStreamFrame, encodeDeviceStreamJson,
  decodeDeviceStreamFrame, decodeDeviceStreamJson,
  decodeDeviceStreamHybridPayload
} from '../../../shared/device-stream-protocol'
import { DEVICE_MULTIPLEX_MAX_STREAMS_PER_CONNECTION, DEVICE_MULTIPLEX_PENDING_MAX_BYTES } from '../../../shared/device-multiplex-flow-control'
import { DeviceStreamServer, registerDeviceStreamServer } from '../rpc/device-stream-server'
import { registerDeviceSession, unregisterDeviceSession, setSourceConstructor } from '../rpc/device-session-host-stub'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { DeviceMediaEvent, DeviceMediaSource } from '../../../shared/device-session-types'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return { getRuntimeId: () => 'test-runtime', registerSubscriptionCleanup: vi.fn(), cleanupSubscription: vi.fn(), ...overrides } as OrcaRuntimeService
}

type BinaryHandler = (frame: NonNullable<ReturnType<typeof decodeDeviceStreamFrame>>) => void

// A transport factory. When `acceptAll` is true (default), every sendBinary call succeeds.
// When false, you can control behavior via overrides.
function makeTransport() {
  const sent: Uint8Array[] = []
  const handlers = new Map<number, BinaryHandler>()
  const sendBinaryFn = (bytes: Uint8Array): boolean | void => { sent.push(bytes); return true }
  const transport = {
    sendBinary: sendBinaryFn,
    registerBinaryStreamHandler: (streamId: number, handler: BinaryHandler) => { handlers.set(streamId, handler); return () => { handlers.delete(streamId) } }
  }
  return {
    transport,
    sent,
    handlers,
    sendOn: (streamId: number, opcode: DeviceStreamOpcode, payload: Uint8Array = new Uint8Array(), seq = 0) => {
      const frame = decodeDeviceStreamFrame(encodeDeviceStreamFrame(opcode, streamId, seq, payload))
      if (frame) { handlers.get(streamId)?.(frame) }
    },
    lastOpenedStreamId: () => {
      for (let i = sent.length - 1; i >= 0; i--) {
        const f = decodeDeviceStreamFrame(sent[i])
        if (f && f.opcode === DeviceStreamOpcode.Opened) { return f.streamId }
      }
      return 0
    }
  }
}

// A media source that captures the subscribe listener and exposes emit + spies
class CapturableSource implements DeviceMediaSource {
  private listener: ((event: DeviceMediaEvent) => void) | null = null
  readonly requestKeyframe = vi.fn()
  readonly setPaused = vi.fn()

  subscribe(listener: (event: DeviceMediaEvent) => void): () => void {
    this.listener = listener
    return () => { this.listener = null }
  }

  emit(event: DeviceMediaEvent): void { this.listener?.(event) }
}

// Helper: open a stream with a given transport, returns the source
function openStream(t: ReturnType<typeof makeTransport>, sessionId: string, deviceId: string): CapturableSource {
  const source = new CapturableSource()
  setSourceConstructor(class FakeCtor implements DeviceMediaSource {
    subscribe(l: (e: DeviceMediaEvent) => void) { return source.subscribe(l) }
    get requestKeyframe() { return source.requestKeyframe }
    get setPaused() { return source.setPaused }
  })
  registerDeviceSession(sessionId, deviceId)
  t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId, deviceId, transport: 'runtime-websocket' }))
  return source
}

describe('DeviceStreamServer', () => {
  let runtime: OrcaRuntimeService
  let server: DeviceStreamServer

  beforeEach(() => {
    runtime = stubRuntime()
    server = registerDeviceStreamServer(runtime)
    setSourceConstructor(class MockSource implements DeviceMediaSource {
      subscribe(_listener: (event: DeviceMediaEvent) => void) { return () => {} }
    })
    registerDeviceSession('test-session', 'test-device')
  })

  afterEach(() => { unregisterDeviceSession('test-session') })

  it('attaches a connection and registers control handler', () => {
    const t = makeTransport(); server.attach('conn-1', t.transport)
    expect(t.handlers.has(0)).toBe(true)
  })

  it('Open allocates a stream and sends Opened', () => {
    const t = makeTransport(); server.attach('conn-1', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'test-session', deviceId: 'test-device', transport: 'runtime-websocket' }))
    expect(t.sent.length).toBeGreaterThanOrEqual(1)
    const lastFrame = decodeDeviceStreamFrame(t.sent.at(-1)!)!
    expect(lastFrame.opcode).toBe(DeviceStreamOpcode.Opened)
    const opened = decodeDeviceStreamJson<{ sessionId: string }>(lastFrame.payload)
    expect(opened?.sessionId).toBe('test-session')
  })

  it('Open with invalid payload sends Error', () => {
    const t = makeTransport(); server.attach('conn-1', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'bad', transport: 'runtime-websocket' }))
    const lastFrame = decodeDeviceStreamFrame(t.sent[0])!; expect(lastFrame.opcode).toBe(DeviceStreamOpcode.Error)
  })

  it('Open unknown session sends Error', () => {
    const t = makeTransport(); server.attach('conn-1', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'unknown', deviceId: 'd1', transport: 'runtime-websocket' }))
    const lastFrame = decodeDeviceStreamFrame(t.sent[0])!; expect(lastFrame.opcode).toBe(DeviceStreamOpcode.Error)
  })

  it('exceeds max streams per connection sends Error', () => {
    const t = makeTransport(); server.attach('conn-1', t.transport)
    for (let i = 0; i < DEVICE_MULTIPLEX_MAX_STREAMS_PER_CONNECTION; i++) {
      registerDeviceSession(`bulk-session-${i}`, `device-${i}`)
      t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: `bulk-session-${i}`, deviceId: `device-${i}`, transport: 'runtime-websocket' }))
    }
    registerDeviceSession('overflow-session', 'overflow-device')
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'overflow-session', deviceId: 'overflow-device', transport: 'runtime-websocket' }))
    const lastFrame = decodeDeviceStreamFrame(t.sent.at(-1)!)!
    expect(lastFrame.opcode).toBe(DeviceStreamOpcode.Error)
    for (let i = 0; i < DEVICE_MULTIPLEX_MAX_STREAMS_PER_CONNECTION; i++) { unregisterDeviceSession(`bulk-session-${i}`) }
    unregisterDeviceSession('overflow-session')
  })

  it('Close from client detaches stream', () => {
    const t = makeTransport(); server.attach('conn-1', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'test-session', deviceId: 'test-device', transport: 'runtime-websocket' }))
    const streamId = t.lastOpenedStreamId()
    t.sendOn(streamId, DeviceStreamOpcode.Close, encodeDeviceStreamJson({}))
    const closeFrame = decodeDeviceStreamFrame(t.sent.at(-1)!)!; expect(closeFrame.opcode).toBe(DeviceStreamOpcode.Close)
  })

  it('Ack credits bytes back to stream window', () => {
    const t = makeTransport(); server.attach('conn-1', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'test-session', deviceId: 'test-device', transport: 'runtime-websocket' }))
    const streamId = t.lastOpenedStreamId()
    t.sendOn(streamId, DeviceStreamOpcode.Ack, encodeDeviceStreamJson({ bytes: 1024 }))
    expect(t.sent.length).toBe(1) // No new frames from Ack
  })

  it('detach on disconnect clears all streams', () => {
    const t = makeTransport(); server.attach('conn-1', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'test-session', deviceId: 'test-device', transport: 'runtime-websocket' }))
    expect(t.handlers.size).toBeGreaterThanOrEqual(1)
    server.detach('conn-1'); expect(t.handlers.size).toBe(0)
  })

  it('subscription cleanup triggers on disconnect', () => {
    const cleanups = new Map<string, () => void>()
    runtime = stubRuntime({
      registerSubscriptionCleanup: vi.fn((id: string, fn: () => void) => { cleanups.set(id, fn) }),
      cleanupSubscription: vi.fn((id: string) => { cleanups.get(id)?.() })
    })
    const localServer = new DeviceStreamServer(runtime)
    const t = makeTransport(); localServer.attach('conn-2', t.transport)
    expect(cleanups.has('device-stream:conn-2')).toBe(true)
    cleanups.get('device-stream:conn-2')!(); expect(t.handlers.size).toBe(0)
  })

  it('sendBinary returning false closes the connection', () => {
    const t = makeTransport(); t.transport.sendBinary = () => false
    server.attach('conn-1', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'test-session', deviceId: 'test-device', transport: 'runtime-websocket' }))
    expect((server as unknown as { connections: Map<string, unknown> }).connections.has('conn-1')).toBe(false)
  })

  // -- Finding #1: drainPending preserves frame seq ------------------------------------------------

  it('preserves frame seq through pending queue and drain', () => {
    const t = makeTransport()
    server.attach('conn-seq', t.transport)
    const source = openStream(t, 'seq-session', 'seq-device')
    const streamId = t.lastOpenedStreamId()

    // Fill ACK window (512 KiB) with large frames so subsequent frames must queue.
    // Sending ~180 KiB frames means 3 fill the window; 4th+ go to pending.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const seq of [1, 2, 3]) {
      source.emit({ type: 'frame', seq, pts: BigInt(seq * 1000), keyFrame: false, bytes: new Uint8Array(180 * 1024).buffer as ArrayBuffer })
    }
    // Frame seq=4 should be enqueued (window full)
    source.emit({ type: 'frame', seq: 4, pts: 4000n, keyFrame: false, bytes: new Uint8Array(180 * 1024).buffer as ArrayBuffer })

    // ACK to drain pending frames
    const drainedStart = t.sent.length
    t.sendOn(streamId, DeviceStreamOpcode.Ack, encodeDeviceStreamJson({ bytes: 1024 * 1024 }))

    // The drained frames should carry their real seq, not 0
    const drained = t.sent.slice(drainedStart)
    expect(drained.length).toBeGreaterThanOrEqual(1)
    for (const frameBytes of drained) {
      const f = decodeDeviceStreamFrame(frameBytes)!
      expect(f.opcode).toBe(DeviceStreamOpcode.Frame)
      expect(f.seq).toBeGreaterThan(0)
    }
    const seqs = drained.map((b) => decodeDeviceStreamFrame(b)!.seq)
    expect(seqs).toContain(4)

    unregisterDeviceSession('seq-session')
  })

  // -- Finding #3: onClose callback resolves the streaming method promise --------------------------

  it('onClose callback is called when connection is detached', () => {
    const onClose = vi.fn()
    const t = makeTransport()
    server.attach('conn-close-test', t.transport, onClose)
    server.detach('conn-close-test')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('onClose callback is called via subscription cleanup', () => {
    const cleanups = new Map<string, () => void>()
    runtime = stubRuntime({
      registerSubscriptionCleanup: vi.fn((id: string, fn: () => void) => { cleanups.set(id, fn) }),
      cleanupSubscription: vi.fn((id: string) => { cleanups.get(id)?.() })
    })
    const localServer = new DeviceStreamServer(runtime)
    const onClose = vi.fn()
    const t = makeTransport()
    localServer.attach('conn-cleanup-test', t.transport, onClose)
    cleanups.get('device-stream:conn-cleanup-test')!()
    expect(onClose).toHaveBeenCalledOnce()
  })

  // -- Finding #4: Source events produce correct binary frames ------------------------------------

  it('source events produce correct binary frames on the wire', () => {
    const t = makeTransport()
    server.attach('conn-src', t.transport)
    const source = openStream(t, 'source-test', 'src-device')
    const openedCount = t.sent.length

    // Emit metadata
    source.emit({ type: 'metadata', codec: 'h264', width: 1280, height: 720 })
    expect(t.sent.length).toBe(openedCount + 1)
    const metaFrame = decodeDeviceStreamFrame(t.sent.at(-1)!)!
    expect(metaFrame.opcode).toBe(DeviceStreamOpcode.Metadata)
    const meta = decodeDeviceStreamJson<{ codec: string }>(metaFrame.payload)
    expect(meta?.codec).toBe('h264')

    // Emit config
    const configBytes = new Uint8Array(new TextEncoder().encode('SPS/PPS')).buffer as ArrayBuffer
    source.emit({ type: 'config', pts: 100n, bytes: configBytes })
    expect(t.sent.length).toBe(openedCount + 2)
    const configFrame = decodeDeviceStreamFrame(t.sent.at(-1)!)!
    expect(configFrame.opcode).toBe(DeviceStreamOpcode.CodecConfig)
    const { metadata: configMeta, bytes: configPayload } = decodeDeviceStreamHybridPayload(configFrame.payload)
    expect(configMeta?.pts).toBe('100')
    expect(new Uint8Array(configPayload)).toEqual(new Uint8Array(configBytes))

    // Emit keyframe
    const frameData = new Uint8Array([0, 0, 0, 1, 0x67]).buffer as ArrayBuffer
    source.emit({ type: 'frame', seq: 0, pts: 200n, keyFrame: true, bytes: frameData })
    expect(t.sent.length).toBe(openedCount + 3)
    const frameFrame = decodeDeviceStreamFrame(t.sent.at(-1)!)!
    expect(frameFrame.opcode).toBe(DeviceStreamOpcode.Frame)
    expect(frameFrame.seq).toBe(0)
    const { metadata: frameMeta, bytes: framePayload } = decodeDeviceStreamHybridPayload(frameFrame.payload)
    expect(frameMeta?.keyFrame).toBe(true)
    expect(frameMeta?.pts).toBe('200')
    expect(new Uint8Array(framePayload)).toEqual(new Uint8Array([0, 0, 0, 1, 0x67]))

    unregisterDeviceSession('source-test')
  })

  // -- Finding #5: Pause/Resume/RequestKeyframe propagation ----------------------------------------

  it('RequestKeyframe, Pause, Resume propagate to media source', () => {
    const t = makeTransport()
    server.attach('conn-ctrl', t.transport)
    const source = openStream(t, 'ctrl-test', 'ctrl-device')
    const streamId = t.lastOpenedStreamId()

    t.sendOn(streamId, DeviceStreamOpcode.RequestKeyframe, new Uint8Array())
    expect(source.requestKeyframe).toHaveBeenCalledOnce()

    t.sendOn(streamId, DeviceStreamOpcode.Pause, new Uint8Array())
    expect(source.setPaused).toHaveBeenCalledWith(true)

    t.sendOn(streamId, DeviceStreamOpcode.Resume, new Uint8Array())
    expect(source.setPaused).toHaveBeenCalledWith(false)

    unregisterDeviceSession('ctrl-test')
  })

  it('sources without requestKeyframe/setPaused do not throw', () => {
    const t = makeTransport()
    server.attach('conn-min', t.transport)
    // Open with test-session (already has MockSource without optional methods)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'test-session', deviceId: 'test-device', transport: 'runtime-websocket' }))
    const streamId = t.lastOpenedStreamId()
    expect(streamId).toBeGreaterThan(0)

    expect(() => {
      t.sendOn(streamId, DeviceStreamOpcode.RequestKeyframe, new Uint8Array())
      t.sendOn(streamId, DeviceStreamOpcode.Pause, new Uint8Array())
      t.sendOn(streamId, DeviceStreamOpcode.Resume, new Uint8Array())
    }).not.toThrow()

    const errorFrames = t.sent.filter((b) => decodeDeviceStreamFrame(b)!.opcode === DeviceStreamOpcode.Error)
    expect(errorFrames).toHaveLength(0)
  })

  // -- Finding #6: Bounded pending queue / frame drop ----------------------------------------------

  it('pending queue never exceeds DEVICE_MULTIPLEX_PENDING_MAX_BYTES and keyframes survive', () => {
    const t = makeTransport()
    server.attach('conn-q', t.transport)
    const source = openStream(t, 'queue-test', 'q-device')
    const streamId = t.lastOpenedStreamId()

    // All frames are 100 KiB to keep ACK window tracking predictable.
    // Initial window = 512 KiB; first 5 frames go through, next ones queue.
    // Pending budget = 256 KiB → ~2.5 frames fit. Oldest non-keyframes dropped.
    const FRAME_SIZE = 100 * 1024
    for (let i = 0; i < 10; i++) {
      source.emit({ type: 'frame', seq: i, pts: BigInt(i * 1000), keyFrame: false, bytes: new Uint8Array(FRAME_SIZE).buffer as ArrayBuffer })
    }

    // Access internal state
    const srv = server as unknown as { connections: Map<string, { streams: Map<number, { pendingOutputBytes: number; pendingOutput: Record<string, unknown>[] }> }> }
    const connState = srv.connections.get('conn-q')!
    const stream = Array.from(connState.streams.values())[0]!

    // Pending bytes should not exceed max (frame len includes hybrid overhead)
    const overhead = 60 // conservative estimate for hybrid header + JSON
    const maxExpected = DEVICE_MULTIPLEX_PENDING_MAX_BYTES + overhead
    expect(stream.pendingOutputBytes).toBeLessThanOrEqual(maxExpected)
    expect(stream.pendingOutput.length).toBeGreaterThan(0)

    // Push a keyframe large frame and verify it survives in the queue
    // (dropping only non-keyframes when over budget)
    source.emit({ type: 'frame', seq: 100, pts: 100000n, keyFrame: true, bytes: new Uint8Array(FRAME_SIZE).buffer as ArrayBuffer })
    const keyframeInQueue = stream.pendingOutput.some((f) => (f as unknown as { seq: number }).seq === 100)
    expect(keyframeInQueue).toBe(true)

    // Drain by ACKing
    t.sendOn(streamId, DeviceStreamOpcode.Ack, encodeDeviceStreamJson({ bytes: 1024 * 1024 }))
    expect(stream.pendingOutput.length).toBe(0)

    unregisterDeviceSession('queue-test')
  })

  // -- Finding #1 (Phase 3 remediation): Client-proposed streamId ---------------------------------

  it('uses client-proposed streamId when provided', () => {
    const t = makeTransport(); server.attach('conn-sid', t.transport)
    const source = new CapturableSource()
    setSourceConstructor(class FakeCtor implements DeviceMediaSource {
      subscribe(l: (e: DeviceMediaEvent) => void) { return source.subscribe(l) }
    })
    registerDeviceSession('sid-session', 'sid-device')
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'sid-session', deviceId: 'sid-device', transport: 'runtime-websocket', streamId: 42 }))
    // Opened should be sent on stream 42 (the client-proposed ID)
    const openedFrame = t.sent.find((b) => decodeDeviceStreamFrame(b)!.opcode === DeviceStreamOpcode.Opened)!
    expect(decodeDeviceStreamFrame(openedFrame)!.streamId).toBe(42)
    // Handler should be registered for stream 42
    expect(t.handlers.has(42)).toBe(true)
    unregisterDeviceSession('sid-session')
  })

  it('Open with streamId 0 is rejected', () => {
    const t = makeTransport(); server.attach('conn-zero', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'test-session', deviceId: 'test-device', transport: 'runtime-websocket', streamId: 0 }))
    const lastFrame = decodeDeviceStreamFrame(t.sent.at(-1)!)!
    expect(lastFrame.opcode).toBe(DeviceStreamOpcode.Error)
    expect(decodeDeviceStreamJson<{ code: string }>(lastFrame.payload)?.code).toBe('invalid_stream_id')
  })

  it('Open with negative streamId is rejected', () => {
    const t = makeTransport(); server.attach('conn-neg', t.transport)
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'test-session', deviceId: 'test-device', transport: 'runtime-websocket', streamId: -1 }))
    const lastFrame = decodeDeviceStreamFrame(t.sent.at(-1)!)!
    expect(lastFrame.opcode).toBe(DeviceStreamOpcode.Error)
    expect(decodeDeviceStreamJson<{ code: string }>(lastFrame.payload)?.code).toBe('invalid_stream_id')
  })

  it('Open with duplicate streamId is rejected', () => {
    const t = makeTransport(); server.attach('conn-dup', t.transport)
    const s1 = new CapturableSource()
    setSourceConstructor(class FakeCtor implements DeviceMediaSource {
      subscribe(l: (e: DeviceMediaEvent) => void) { return s1.subscribe(l) }
    })
    registerDeviceSession('dup-session-1', 'dup-device-1')
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'dup-session-1', deviceId: 'dup-device-1', transport: 'runtime-websocket', streamId: 7 }))
    // Second open with same streamId
    registerDeviceSession('dup-session-2', 'dup-device-2')
    t.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'dup-session-2', deviceId: 'dup-device-2', transport: 'runtime-websocket', streamId: 7 }))
    const errorFrames = t.sent.filter((b) => decodeDeviceStreamFrame(b)!.opcode === DeviceStreamOpcode.Error && decodeDeviceStreamJson<{ code: string }>(decodeDeviceStreamFrame(b)!.payload)?.code === 'invalid_stream_id')
    expect(errorFrames.length).toBeGreaterThanOrEqual(1)
    unregisterDeviceSession('dup-session-1')
    unregisterDeviceSession('dup-session-2')
  })

  it('Open without streamId falls back to server allocation (backward compat)', () => {
    const t = makeTransport(); server.attach('conn-fallback', t.transport)
    // openStream helper sends Open without streamId
    openStream(t, 'fallback-session', 'fallback-device')
    const streamId = t.lastOpenedStreamId()
    expect(streamId).toBeGreaterThan(0)
    expect(t.handlers.has(streamId)).toBe(true)
    unregisterDeviceSession('fallback-session')
  })
})
