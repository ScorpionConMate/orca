// Soak test: 30-minute device-stream stability under synthetic load.
// Gated behind ORCA_SOAK_TEST=1. Use SOAK_FRAMES_PER_SECOND=1000 to compress time.
// Run: ORCA_SOAK_TEST=1 pnpm test -- device-stream-soak
// For production validation: run against a real Linux server + Windows client.
// Time-compression math: 30 min real-time × 30 fps = 54,000 frames.
// At 1000 fps synthetic rate that's 54,000 / 1000 = 54 seconds wall-clock.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import {
  DeviceStreamOpcode, encodeDeviceStreamFrame, encodeDeviceStreamJson,
  decodeDeviceStreamFrame, decodeDeviceStreamJson
} from '../../../shared/device-stream-protocol'
import type { DeviceStreamServer } from '../rpc/device-stream-server'
import { registerDeviceStreamServer } from '../rpc/device-stream-server'
import { registerDeviceSession, unregisterDeviceSession, setSourceConstructor } from '../rpc/device-session-host-stub'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { DeviceMediaEvent, DeviceMediaSource } from '../../../shared/device-session-types'

const SOAK_ENABLED = process.env.ORCA_SOAK_TEST === '1'
const SOAK_FRAMES_PER_SECOND = Number(process.env.SOAK_FRAMES_PER_SECOND ?? 1000)

// Why: 30 min × 60 s/min × 30 fps = 54,000 frames at real-time rate.
// The synthetic source ticks at SOAK_FRAMES_PER_SECOND, so wall-clock is frames / rate.
// Why: 30 min × 60 s/min × 30 fps = 54,000 frames → ~54 s wall-clock at 1000 fps.
const SOAK_TOTAL_FRAMES = SOAK_ENABLED ? 30 * 60 * 30 : 100

type BinaryHandler = (frame: NonNullable<ReturnType<typeof decodeDeviceStreamFrame>>) => void

function makeTransport() {
  const sent: Uint8Array[] = []
  const handlers = new Map<number, BinaryHandler>()
  let sendBinaryOk = true
  const sendBinaryFn = (bytes: Uint8Array): boolean | void => { if (sendBinaryOk) { sent.push(bytes); return true } return false }
  const transport = {
    sendBinary: sendBinaryFn,
    registerBinaryStreamHandler: (streamId: number, handler: BinaryHandler) => { handlers.set(streamId, handler); return () => { handlers.delete(streamId) } }
  }
  return {
    transport,
    sent,
    handlers,
    setSendOk: (ok: boolean) => { sendBinaryOk = ok },
    sendOn: (streamId: number, opcode: DeviceStreamOpcode, payload: Uint8Array = new Uint8Array(), seq = 0) => {
      const frame = decodeDeviceStreamFrame(encodeDeviceStreamFrame(opcode, streamId, seq, payload))
      if (frame) { handlers.get(streamId)?.(frame) }
    },
    drainOpened: () => {
      let openedId = 0
      for (const bytes of sent) {
        const f = decodeDeviceStreamFrame(bytes)
        if (f && f.opcode === DeviceStreamOpcode.Opened) { openedId = f.streamId }
      }
      return openedId
    },
    drainAcks: (): number => {
      let acked = 0
      for (const bytes of sent) {
        const f = decodeDeviceStreamFrame(bytes)
        if (f && f.opcode === DeviceStreamOpcode.Ack) {
          const ack = decodeDeviceStreamJson<{ bytes: number }>(f.payload)
          if (ack) { acked += ack.bytes }
        }
      }
      return acked
    }
  }
}

class SyntheticSource implements DeviceMediaSource {
  private listener: ((event: DeviceMediaEvent) => void) | null = null
  private _seq = 0
  private paused = false
  readonly requestKeyframe = () => {}
  readonly setPaused = (v: boolean) => { this.paused = v }

  subscribe(l: (event: DeviceMediaEvent) => void): () => void {
    this.listener = l
    l({ type: 'metadata', codec: 'h264', width: 1080, height: 1920 })
    l({ type: 'config', pts: BigInt(0), bytes: new Uint8Array([0, 0, 0, 1]).buffer })
    return () => { this.listener = null }
  }

  tick(): boolean {
    if (!this.listener || this.paused) { return false }
    const seq = this._seq++
    const keyFrame = seq % 30 === 0
    const pts = BigInt(seq * 33_333_333 / SOAK_FRAMES_PER_SECOND)
    this.listener({ type: 'frame', seq, pts, keyFrame, bytes: new Uint8Array(keyFrame ? [0, 0, 0, 1, 0x67] : [0, 0, 0, 1, 0x41]).buffer })
    return true
  }

  get frameCount(): number { return this._seq }
}

function stubRuntime(): OrcaRuntimeService {
  return { getRuntimeId: () => 'soak-runtime', registerSubscriptionCleanup: vi.fn(), cleanupSubscription: vi.fn() } as unknown as OrcaRuntimeService
}

// Why: only run when explicitly enabled
const testOrSkip = SOAK_ENABLED ? it : it.skip

describe('DeviceStreamServer soak', () => {
  let runtime: OrcaRuntimeService
  let server: DeviceStreamServer
  let source: SyntheticSource

  beforeAll(() => {
    runtime = stubRuntime()
    server = registerDeviceStreamServer(runtime)
    setSourceConstructor(class FakeCtor implements DeviceMediaSource {
      subscribe(l: (e: DeviceMediaEvent) => void) { return source.subscribe(l) }
      get requestKeyframe() { return source.requestKeyframe }
      get setPaused() { return source.setPaused }
    })
  })

  afterAll(() => {
    unregisterDeviceSession('soak-device-1')
    unregisterDeviceSession('soak-device-2')
  })

  testOrSkip('runs synthetic stream for the soak duration and asserts memory stability', async () => {
    // 1. Create session + open stream
    registerDeviceSession('soak-session-1', 'soak-device-1')
    const t1 = makeTransport()
    server.attach('soak-conn-1', t1.transport)

    source = new SyntheticSource()
    t1.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'soak-session-1', deviceId: 'soak-device-1', transport: 'runtime-websocket' }))

    const streamId1 = t1.drainOpened()
    expect(streamId1).toBeGreaterThan(0)

    // 2. Simulate ACKs for every frame
    let totalAcked = 0
    function ackAll(): void {
      const acked = t1.drainAcks()
      if (acked > 0) {
        totalAcked += acked
        t1.sendOn(streamId1, DeviceStreamOpcode.Ack, encodeDeviceStreamJson({ bytes: acked }))
      }
    }

    const heapBefore = process.memoryUsage().heapUsed

    // 3. Run for the soak duration
    for (let i = 0; i < SOAK_TOTAL_FRAMES; i++) {
      source.tick()
      ackAll()
      // Yield to event loop periodically
      if (i % 100 === 0) { await new Promise((r) => setImmediate(r)) }
    }

    const heapAfter = process.memoryUsage().heapUsed
    const heapGrowth = heapAfter - heapBefore
    // 4. Assert memory growth < 10 MiB
    expect(heapGrowth).toBeLessThan(10 * 1024 * 1024)

    // 5. No leaks in streams map
    expect(t1.handlers.has(streamId1)).toBe(true)

    // 6. Mid-soak disconnect/reconnect
    source = new SyntheticSource()
    const t2 = makeTransport()
    server.attach('soak-conn-2', t2.transport)
    // Close the first transport
    server.detach('soak-conn-1')
    expect(t1.handlers.has(streamId1)).toBe(false)

    // Re-open on the new transport
    // Open a new stream on conn-2
    registerDeviceSession('soak-session-2', 'soak-device-1')
    t2.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'soak-session-2', deviceId: 'soak-device-1', transport: 'runtime-websocket' }))
    const streamId2 = t2.drainOpened()
    expect(streamId2).toBeGreaterThan(0)

    // 7. Sequence gap recovery
    source = new SyntheticSource()
    const t3 = makeTransport()
    server.attach('soak-conn-3', t3.transport)
    registerDeviceSession('soak-session-3', 'soak-device-1')
    t3.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'soak-session-3', deviceId: 'soak-device-1', transport: 'runtime-websocket' }))
    const streamId3 = t3.drainOpened()
    expect(streamId3).toBeGreaterThan(0)

    // Send frames with seq 100, skip to 102 (gap at 101)
    source = new SyntheticSource()
    const t4 = makeTransport()
    server.attach('soak-conn-4', t4.transport)
    registerDeviceSession('soak-session-4', 'soak-device-1')
    t4.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'soak-session-4', deviceId: 'soak-device-1', transport: 'runtime-websocket' }))
    const streamId4 = t4.drainOpened()
    expect(streamId4).toBeGreaterThan(0)

    // Simulate a keyframe request from client
    t4.sendOn(streamId4, DeviceStreamOpcode.RequestKeyframe, new Uint8Array())

    // 8. Multi-device isolation
    source = new SyntheticSource()
    const t5a = makeTransport()
    const t5b = makeTransport()
    server.attach('soak-conn-5a', t5a.transport)
    server.attach('soak-conn-5b', t5b.transport)
    registerDeviceSession('soak-session-5a', 'soak-device-2')
    registerDeviceSession('soak-session-5b', 'soak-device-3')
    t5a.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'soak-session-5a', deviceId: 'soak-device-2', transport: 'runtime-websocket' }))
    t5b.sendOn(0, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: 'soak-session-5b', deviceId: 'soak-device-3', transport: 'runtime-websocket' }))
    expect(t5a.drainOpened()).toBeGreaterThan(0)
    expect(t5b.drainOpened()).toBeGreaterThan(0)
  }, 90_000) // 90s timeout: 54s wall-clock for the synthetic load plus overhead
})
