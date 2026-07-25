// Client-side multiplexer for device binary streams (H.264/MJPEG over E2EE WebSocket).
// Mirrors the structure of remote-runtime-terminal-multiplexer.ts but for device streams.
// Singleton per environmentId.
import type { DeviceSessionDescriptor } from '../../../shared/device-session-types'
import {
  DeviceStreamOpcode,
  decodeDeviceStreamFrame,
  encodeDeviceStreamFrame,
  encodeDeviceStreamJson
} from '../../../shared/device-stream-protocol'
import { DEVICE_RECONNECT_DELAYS_MS, DEVICE_RECONNECT_MAX_ATTEMPTS } from '../../../shared/device-multiplex-flow-control'
import { isRecoverableRemoteRuntimeConnectionError } from '../../../shared/remote-runtime-client-error-classification'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { RemoteDeviceMediaSource } from './remote-device-media-source'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { trackReconnectStarted, trackReconnectSucceeded, trackReconnectFailed } from './device-telemetry-client'

type SubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array) => void
}

type StreamEntry = {
  streamId: number
  source: RemoteDeviceMediaSource
  descriptor: DeviceSessionDescriptor
}

// Why: descriptor kept for re-subscribe on transport reconnect
type ReconnectEntry = {
  descriptor: DeviceSessionDescriptor
  streamId: number
}

const ControlStreamId = 0

class RemoteRuntimeDeviceMultiplexer {
  private readonly streams = new Map<number, StreamEntry>()
  private subscription: SubscriptionHandle | null = null
  private connectPromise: Promise<void> | null = null
  private readyResolver: (() => void) | null = null
  private readyRejecter: ((error: Error) => void) | null = null
  private ready = false
  private nextStreamId = 1
  private streamHandlers = new Map<
    number,
    (frame: { opcode: DeviceStreamOpcode; seq: number; payload: Uint8Array }) => void
  >()

  // Phase 4: reconnect state
  private reconnectEntries: ReconnectEntry[] | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly environmentId: string,
    private readonly environmentRevision: number | undefined,
    private readonly releaseIfCurrent: (
      environmentId: string,
      multiplexer: RemoteRuntimeDeviceMultiplexer
    ) => void
  ) {}

  matchesRevision(): boolean {
    return getRuntimeEnvironmentRevision(this.environmentId) === this.environmentRevision
  }

  async attachStream(sd: DeviceSessionDescriptor): Promise<{ streamId: number; source: RemoteDeviceMediaSource; close: () => void }> {
    const streamId = this.allocateStreamId()
    const source = new RemoteDeviceMediaSource(sd, {
      sendBinary: (bytes) => this.sendRaw(bytes),
      registerStreamHandler: (sid, h) => {
        this.streamHandlers.set(sid, h)
        return () => { if (this.streamHandlers.get(sid) === h) { this.streamHandlers.delete(sid) } }
      }
    }, streamId)
    const entry: StreamEntry = { streamId, source, descriptor: sd }
    this.streams.set(streamId, entry)

    const handle = {
      streamId,
      source,
      close: () => {
        if (this.streams.get(streamId) === entry) {
          this.sendFrame(ControlStreamId, DeviceStreamOpcode.Close, encodeDeviceStreamJson({}))
          this.streams.delete(streamId)
          this.removeReconnectEntry(streamId)
          this.closeIfIdle()
        }
      }
    }

    try {
      await this.ensureConnected()
      if (this.streams.get(streamId) !== entry) { return handle }
      if (!this.sendFrame(ControlStreamId, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: sd.sessionId, deviceId: sd.deviceId, transport: 'runtime-websocket', streamId }))) {
        throw new Error('Remote device stream transport is not connected.')
      }
    } catch (error) {
      if (this.streams.get(streamId) === entry) { this.streams.delete(streamId); this.closeIfIdle() }
      throw error
    }
    return handle
  }

  private allocateStreamId(): number {
    const start = this.nextStreamId
    do {
      const c = this.nextStreamId
      this.nextStreamId = this.nextStreamId >= 0x7fffffff ? 1 : this.nextStreamId + 1
      if (!this.streams.has(c)) { return c }
    } while (this.nextStreamId !== start)
    throw new Error('No remote device stream ids available.')
  }

  private sendFrame(sid: number, opcode: DeviceStreamOpcode, payload: Uint8Array = new Uint8Array()): boolean {
    if (!this.matchesRevision() || !this.ready || !this.subscription) { return false }
    try { this.subscription.sendBinary(encodeDeviceStreamFrame(opcode, sid, 0, payload)); return true }
    catch { this.handleClose('Remote device stream transport write failed.'); return false }
  }

  private sendRaw(bytes: Uint8Array): boolean {
    if (!this.ready || !this.subscription) { return false }
    try { this.subscription.sendBinary(bytes); return true }
    catch { this.handleClose('Remote device stream transport write failed.'); return false }
  }

  private ensureConnected(): Promise<void> {
    if (this.ready && this.subscription) { return Promise.resolve() }
    if (this.connectPromise) { return this.connectPromise }
    const p = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve; this.readyRejecter = reject
      void window.api.runtimeEnvironments.subscribe(
        { selector: this.environmentId, method: 'emulator.stream.start', params: {}, timeoutMs: 15_000, expectedEnvironmentPairingRevision: this.environmentRevision },
        {
          onResponse: (res) => this.handleResponse(res),
          onBinary: (bytes) => this.handleBinary(bytes),
          onError: (error) => isRecoverableRemoteRuntimeConnectionError(error) ? this.handleClose(error.message) : this.failConnection(Object.assign(new Error(error.message), { code: error.code })),
          onClose: () => this.handleClose('Remote Orca runtime closed the device stream connection.')
        }
      ).then((sub) => {
        if (this.connectPromise !== p || (!this.ready && !this.readyRejecter)) { sub.unsubscribe(); return }
        this.subscription = sub; this.resolveReadyIfConnected()
      }).catch((error) => {
        if (this.connectPromise === p) { this.connectPromise = null; this.readyResolver = null; this.readyRejecter = null }
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
    this.connectPromise = p
    return p
  }

  private handleResponse(response: RuntimeRpcResponse<unknown>): void {
    if (!this.matchesRevision()) { this.closeForEnvironmentReplacement(); return }
    try {
      const event = unwrapRuntimeRpcResult(response) as { type?: string }
      if (event?.type === 'ready') { this.ready = true; this.resolveReadyIfConnected() }
    } catch { /* non-ready events don't affect connection state */ }
  }

  private handleBinary(bytes: Uint8Array): void {
    if (!this.matchesRevision()) { this.closeForEnvironmentReplacement(); return }
    const frame = decodeDeviceStreamFrame(bytes)
    if (!frame) { return }
    const handler = this.streamHandlers.get(frame.streamId)
    if (handler) { handler({ opcode: frame.opcode, seq: frame.seq, payload: frame.payload }) }
  }

  private resolveReadyIfConnected(): void {
    if (!this.ready || !this.subscription) { return }
    this.readyResolver?.(); this.readyResolver = null; this.readyRejecter = null
  }

  private failConnection(error: Error): void {
    this.readyRejecter?.(error); this.readyResolver = null; this.readyRejecter = null
    this.handleClose(undefined, false)
  }

  closeForEnvironmentReplacement(): void {
    this.clearReconnect()
    this.handleClose('Runtime environment pairing changed.')
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.reconnectEntries = null
    this.reconnectAttempt = 0
  }

  private removeReconnectEntry(streamId: number): void {
    if (!this.reconnectEntries) { return }
    this.reconnectEntries = this.reconnectEntries.filter((e) => e.streamId !== streamId)
    if (this.reconnectEntries.length === 0) { this.clearReconnect() }
  }

  // Phase 4: attempt re-subscribe for kept streams; returns true if reconnect was initiated
  private tryReconnect(): boolean {
    if (!this.reconnectEntries || this.reconnectEntries.length === 0) { return false }
    if (this.reconnectAttempt >= DEVICE_RECONNECT_MAX_ATTEMPTS) {
      // Max attempts — notify sources and clean up
      for (const entry of this.reconnectEntries) {
        const stream = this.streams.get(entry.streamId)
        if (stream) {
          stream.source.handleTransportClose()
          this.streams.delete(entry.streamId)
        }
      }
      this.reconnectEntries = null
      this.reconnectAttempt = 0
      this.releaseIfCurrent(this.environmentId, this)
      return false
    }
    this.reconnectAttempt++
    trackReconnectStarted({
      sessionId: this.reconnectEntries.at(0)!.descriptor.sessionId,
      deviceId: this.reconnectEntries.at(0)!.descriptor.deviceId,
      attempt: this.reconnectAttempt
    })
    void this.reconnectStreams()
    return true
  }

  // Phase 4: re-establish connection + re-subscribe kept streams
  private async reconnectStreams(): Promise<void> {
    const entries = this.reconnectEntries
    if (!entries || entries.length === 0) { return }
    try {
      await this.ensureConnected()
      if (!this.reconnectEntries) { return }
      // Re-open each stream
      for (const entry of entries) {
        const stream = this.streams.get(entry.streamId)
        if (!stream) { continue }
        // Re-register handler for the new subscription
        stream.source.rebindHandler({
          sendBinary: (bytes) => this.sendRaw(bytes),
          registerStreamHandler: (sid, h) => {
            this.streamHandlers.set(sid, h)
            return () => { if (this.streamHandlers.get(sid) === h) { this.streamHandlers.delete(sid) } }
          }
        })
        this.sendFrame(ControlStreamId, DeviceStreamOpcode.Open, encodeDeviceStreamJson({ sessionId: entry.descriptor.sessionId, deviceId: entry.descriptor.deviceId, transport: 'runtime-websocket', streamId: entry.streamId }))
      }
      trackReconnectSucceeded({
        sessionId: entries.at(0)!.descriptor.sessionId,
        deviceId: entries.at(0)!.descriptor.deviceId,
        attempt: this.reconnectAttempt
      })
      this.reconnectEntries = null
      this.reconnectAttempt = 0
    } catch {
      if (!this.reconnectEntries) { return }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEntries || this.reconnectEntries.length === 0) { return }
    const delay = this.reconnectAttempt - 1 < DEVICE_RECONNECT_DELAYS_MS.length
      ? DEVICE_RECONNECT_DELAYS_MS[this.reconnectAttempt - 1]!
      : DEVICE_RECONNECT_DELAYS_MS.at(-1)!
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.tryReconnect()) {
        // Reconnect exhausted — notify all
        trackReconnectFailed({
          sessionId: this.reconnectEntries?.at(0)?.descriptor.sessionId ?? '',
          deviceId: this.reconnectEntries?.at(0)?.descriptor.deviceId ?? '',
          attempt: this.reconnectAttempt
        })
      }
    }, delay)
    if (typeof (this.reconnectTimer as ReturnType<typeof setTimeout>).unref === 'function') {
      ;(this.reconnectTimer as ReturnType<typeof setTimeout>).unref()
    }
  }

  private handleClose(message?: string, _recoverable = true): void {
    const entries = Array.from(this.streams.values())
    const hasActiveStreams = entries.length > 0
    if (hasActiveStreams && this.reconnectEntries === null) {
      this.reconnectEntries = entries.map((e) => ({ descriptor: e.descriptor, streamId: e.streamId }))
    }
    const closingSub = this.subscription
    this.ready = false; this.connectPromise = null
    this.readyRejecter?.(new Error(message ?? 'Remote device stream connection closed.'))
    this.readyResolver = null; this.readyRejecter = null; this.subscription = null
    closingSub?.unsubscribe()
    // Why: keep stream entries (keyed by streamId) so reconnectStreams() can rebind them;
    // only clear the old subscription-bound handlers
    this.streamHandlers.clear()
    this.releaseIfCurrent(this.environmentId, this)
    // Why: notify sources about transport close; reconnectEntries are saved above
    for (const e of entries) { e.source.handleTransportClose() }
    // Phase 4: initiate reconnect if there were open streams
    if (hasActiveStreams && this.reconnectEntries) {
      this.scheduleReconnect()
    }
  }

  private closeIfIdle(): void {
    if (this.streams.size > 0) { return }
    this.clearReconnect()
    this.subscription?.unsubscribe(); this.subscription = null; this.connectPromise = null; this.ready = false
    this.releaseIfCurrent(this.environmentId, this)
  }
}

const multiplexers = new Map<string, RemoteRuntimeDeviceMultiplexer>()

function releaseMultiplexer(id: string, m: RemoteRuntimeDeviceMultiplexer): void {
  if (multiplexers.get(id) === m) { multiplexers.delete(id) }
}

export function getRemoteRuntimeDeviceMultiplexer(environmentId: string): RemoteRuntimeDeviceMultiplexer {
  let m = multiplexers.get(environmentId)
  if (m && !m.matchesRevision()) { m.closeForEnvironmentReplacement(); m = undefined }
  if (!m) {
    m = new RemoteRuntimeDeviceMultiplexer(environmentId, getRuntimeEnvironmentRevision(environmentId), releaseMultiplexer)
    multiplexers.set(environmentId, m)
  }
  return m
}

export function _getRemoteRuntimeDeviceMultiplexerCountForTest(): number { return multiplexers.size }
export function resetRemoteRuntimeDeviceMultiplexersForTests(): void { multiplexers.clear() }
