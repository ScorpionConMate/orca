// Host-side multiplexer for device binary streams (H.264/MJPEG over E2EE WebSocket).
// Mirrors the terminal multiplex structure in methods/terminal.ts (lines 1597-2553).
import type { OrcaRuntimeService } from '../orca-runtime'
import type { DeviceMediaEvent, DeviceMediaSource } from '../../../shared/device-session-types'
import {
  DeviceStreamOpcode, encodeDeviceStreamFrame, encodeDeviceStreamJson,
  encodeDeviceStreamHybridPayload, decodeDeviceStreamJson, DEVICE_STREAM_MAX_FRAME_BYTES,
  type DeviceStreamFrame
} from '../../../shared/device-stream-protocol'
import {
  DEVICE_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES, DEVICE_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  DEVICE_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES, DEVICE_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES,
  DEVICE_MULTIPLEX_PENDING_MAX_BYTES, DEVICE_MULTIPLEX_MAX_STREAMS_PER_CONNECTION
} from '../../../shared/device-multiplex-flow-control'
import { drainTerminalMultiplexRoundRobin } from './terminal-multiplex-round-robin'
import { registerDeviceSession, unregisterDeviceSession, getDeviceSession, listDeviceSessions, incrementSubscriberCount, decrementSubscriberCount, type DeviceSessionHost } from './device-session-host-stub'
import { trackDeviceStreamOpened, trackDeviceStreamClosed, trackDeviceStreamFrameDropped, trackDeviceStreamKeyframeRequested } from './device-telemetry'

export { registerDeviceSession, unregisterDeviceSession, getDeviceSession, listDeviceSessions }
export type { DeviceSessionHost }

export type DeviceStreamBinaryTransport = {
  sendBinary: (bytes: Uint8Array) => boolean | void
  registerBinaryStreamHandler: (streamId: number, handler: (frame: DeviceStreamFrame) => void) => () => void
}

type DeviceStreamState = {
  streamId: number; deviceId: string; sessionId: string; mediaSource: DeviceMediaSource
  unsubscribeSource: () => void; unregisterBinaryHandler: () => void
  ackInFlightBytes: number; ackWindowBytes: number
  pendingOutput: DevicePendingFrame[]; pendingOutputBytes: number
  lastCodecConfig: Uint8Array | null; lastKeyFrame: Uint8Array | null
  lastMetadata: { codec: string; width: number; height: number } | null
  seq: number; closed: boolean
}
type DevicePendingFrame = { opcode: DeviceStreamOpcode; bytes: Uint8Array; seq: number; keyFrame?: boolean }
type ConnectionState = {
  connectionId: string; transport: DeviceStreamBinaryTransport
  streams: Map<number, DeviceStreamState>; nextStreamId: number
  ackTotalInFlightBytes: number; ackTotalWindowBytes: number
  ackFlushCursorStreamId: number | null; unregisterControlHandler: () => void; closed: boolean
  onClose: (() => void) | null
}

export class DeviceStreamServer {
  private readonly runtime: OrcaRuntimeService
  private readonly connections = new Map<string, ConnectionState>()

  constructor(runtime: OrcaRuntimeService) { this.runtime = runtime }

  attach(connectionId: string, transport: DeviceStreamBinaryTransport, onClose?: () => void): void {
    if (this.connections.has(connectionId)) { return }
    const state: ConnectionState = {
      connectionId, transport, streams: new Map(), nextStreamId: 1,
      ackTotalInFlightBytes: 0, ackTotalWindowBytes: DEVICE_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES,
      ackFlushCursorStreamId: null, unregisterControlHandler: () => {}, closed: false,
      onClose: onClose ?? null
    }
    state.unregisterControlHandler = transport.registerBinaryStreamHandler(0, (f) => this.handleControlFrame(state, f))
    this.connections.set(connectionId, state)
    this.runtime.registerSubscriptionCleanup(`device-stream:${connectionId}`, () => this.closeConnection(connectionId), connectionId)
  }

  detach(connectionId: string): void { this.closeConnection(connectionId) }

  private closeConnection(connectionId: string): void {
    const state = this.connections.get(connectionId)
    if (!state) { return }
    state.closed = true
    for (const sid of Array.from(state.streams.keys())) { this.detachStream(state, sid) }
    state.unregisterControlHandler()
    this.connections.delete(connectionId)
    state.onClose?.()
  }

  private handleControlFrame(state: ConnectionState, frame: DeviceStreamFrame): void {
    if (state.closed) { return }
    switch (frame.opcode) {
      case DeviceStreamOpcode.Open: void this.handleOpen(state, frame); break
      case DeviceStreamOpcode.Ack: this.handleAck(state, frame); break
      case DeviceStreamOpcode.RequestKeyframe: this.handleRequestKeyframe(state, frame); break
      case DeviceStreamOpcode.Pause: this.handlePauseResume(state, frame, true); break
      case DeviceStreamOpcode.Resume: this.handlePauseResume(state, frame, false); break
      case DeviceStreamOpcode.Close: this.handleCloseStream(state, frame); break
      // Server→client opcodes are never received on the control stream
      case DeviceStreamOpcode.Opened: case DeviceStreamOpcode.Metadata: case DeviceStreamOpcode.CodecConfig: case DeviceStreamOpcode.Frame: case DeviceStreamOpcode.Error: break
    }
  }

  private async handleOpen(state: ConnectionState, frame: DeviceStreamFrame): Promise<void> {
    if (state.streams.size >= DEVICE_MULTIPLEX_MAX_STREAMS_PER_CONNECTION) {
      this.sendFrame(state, 0, DeviceStreamOpcode.Error, encodeDeviceStreamJson({ code: 'stream_limit_exceeded', message: 'Max streams per connection reached' }))
      return
    }
    const p = decodeDeviceStreamJson<{ sessionId?: string; deviceId?: string; transport?: string; streamId?: number }>(frame.payload)
    if (!p?.sessionId || !p?.deviceId || p.transport !== 'runtime-websocket') {
      this.sendFrame(state, 0, DeviceStreamOpcode.Error, encodeDeviceStreamJson({ code: 'invalid_open', message: 'Missing sessionId, deviceId, or invalid transport' }))
      return
    }
    // Use client-proposed streamId if valid; fallback to server allocation for backward compat.
    const proposedStreamId = p.streamId
    if (proposedStreamId !== undefined) {
      if (!Number.isInteger(proposedStreamId) || proposedStreamId < 1) {
        this.sendFrame(state, 0, DeviceStreamOpcode.Error, encodeDeviceStreamJson({ code: 'invalid_stream_id', message: 'streamId must be a positive integer' }))
        return
      }
      if (state.streams.has(proposedStreamId)) {
        this.sendFrame(state, 0, DeviceStreamOpcode.Error, encodeDeviceStreamJson({ code: 'invalid_stream_id', message: `streamId ${proposedStreamId} is already in use` }))
        return
      }
    }
    const sessionEntry = getDeviceSession(p.sessionId)
    if (!sessionEntry) {
      this.sendFrame(state, 0, DeviceStreamOpcode.Error, encodeDeviceStreamJson({ code: 'session_not_found', message: `Session not found: ${p.sessionId}` }))
      return
    }
    const streamId = proposedStreamId ?? state.nextStreamId++
    // Phase 4: bound subscriber count per session
    if (!incrementSubscriberCount(p.sessionId)) {
      this.sendFrame(state, 0, DeviceStreamOpcode.Error, encodeDeviceStreamJson({ code: 'too_many_subscribers', message: 'Session subscriber limit reached' }))
      return
    }
    const mediaSource = sessionEntry.createMediaSource()
    const stream: DeviceStreamState = {
      streamId, deviceId: p.deviceId, sessionId: p.sessionId, mediaSource,
      unsubscribeSource: () => {}, unregisterBinaryHandler: () => {},
      ackInFlightBytes: 0, ackWindowBytes: DEVICE_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
      pendingOutput: [], pendingOutputBytes: 0,
      lastCodecConfig: null, lastKeyFrame: null, lastMetadata: null, seq: 0, closed: false
    }
    stream.unregisterBinaryHandler = state.transport.registerBinaryStreamHandler(streamId, (f) => this.handleStreamFrame(state, stream, f))
    state.streams.set(streamId, stream)
    stream.unsubscribeSource = mediaSource.subscribe((ev) => { if (!stream.closed && !state.closed) { this.handleMediaEvent(state, stream, ev) } })
    // Confirm + emit structured event
    this.sendFrame(state, stream.streamId, DeviceStreamOpcode.Opened, encodeDeviceStreamJson({
      sessionId: sessionEntry.sessionId, deviceId: stream.deviceId, transport: 'runtime-websocket', capabilities: sessionEntry.capabilities
    }))
    trackDeviceStreamOpened({ sessionId: p.sessionId, deviceId: p.deviceId, streamId })
  }

  private handleMediaEvent(state: ConnectionState, stream: DeviceStreamState, event: DeviceMediaEvent): void {
    switch (event.type) {
      case 'metadata':
        stream.lastMetadata = { codec: event.codec, width: event.width, height: event.height }
        this.sendFrame(state, stream.streamId, DeviceStreamOpcode.Metadata, encodeDeviceStreamJson(event))
        break
      case 'config':
        stream.lastCodecConfig = new Uint8Array(event.bytes)
        this.sendFrame(state, stream.streamId, DeviceStreamOpcode.CodecConfig, encodeDeviceStreamHybridPayload({ pts: String(event.pts) }, event.bytes))
        break
      case 'frame': {
        const bytes = new Uint8Array(event.bytes)
        if (event.keyFrame) { stream.lastKeyFrame = bytes }
        if (bytes.byteLength > DEVICE_STREAM_MAX_FRAME_BYTES) {
          this.sendFrame(state, stream.streamId, DeviceStreamOpcode.Error, encodeDeviceStreamJson({ code: 'payload_too_large', message: `Frame ${bytes.byteLength} > ${DEVICE_STREAM_MAX_FRAME_BYTES}` }))
          this.closeStream(state, stream); return
        }
        this.queueFrameOutput(state, stream, DeviceStreamOpcode.Frame, { pts: String(event.pts), keyFrame: event.keyFrame }, bytes, event.seq)
        break
      }
      case 'error': this.sendFrame(state, stream.streamId, DeviceStreamOpcode.Error, encodeDeviceStreamJson({ code: event.code, message: event.message })); this.closeStream(state, stream); break
      case 'closed': this.closeStream(state, stream); break
    }
  }

  private queueFrameOutput(state: ConnectionState, stream: DeviceStreamState, opcode: DeviceStreamOpcode, metadata: Record<string, unknown>, bytes: Uint8Array, seq: number): void {
    const fb = encodeDeviceStreamHybridPayload(metadata, bytes.buffer as ArrayBuffer)
    const keyFrame = metadata.keyFrame === true
    const chunk: DevicePendingFrame = { opcode, bytes: fb, seq, keyFrame }
    if (!this.canSendFrame(state, stream, fb.byteLength)) { this.enqueuePending(stream, chunk); return }
    this.sendPendingFrame(state, stream, chunk, seq)
  }

  private canSendFrame(state: ConnectionState, stream: DeviceStreamState, bytes: number): boolean {
    return stream.ackInFlightBytes + bytes <= stream.ackWindowBytes && state.ackTotalInFlightBytes + bytes <= state.ackTotalWindowBytes
  }

  private enqueuePending(stream: DeviceStreamState, chunk: DevicePendingFrame): void {
    stream.pendingOutput.push(chunk)
    stream.pendingOutputBytes += chunk.bytes.byteLength
    while (stream.pendingOutputBytes > DEVICE_MULTIPLEX_PENDING_MAX_BYTES && stream.pendingOutput.length > 1) {
      const d = stream.pendingOutput.shift()
      if (d) {
        stream.pendingOutputBytes -= d.bytes.byteLength
        // Phase 4: emit when overflow drops a non-keyframe
        if (d.opcode === DeviceStreamOpcode.Frame && !d.keyFrame) {
          trackDeviceStreamFrameDropped({ sessionId: stream.sessionId, deviceId: stream.deviceId, streamId: stream.streamId, pendingBytesBefore: stream.pendingOutputBytes + d.bytes.byteLength })
        }
      }
    }
  }

  private sendPendingFrame(state: ConnectionState, stream: DeviceStreamState, chunk: DevicePendingFrame, seq: number): void {
    const sent = state.transport.sendBinary(encodeDeviceStreamFrame(chunk.opcode, stream.streamId, seq, chunk.bytes))
    if (sent === false) { this.closeConnection(state.connectionId); return }
    stream.ackInFlightBytes += chunk.bytes.byteLength
    state.ackTotalInFlightBytes += chunk.bytes.byteLength
  }

  private drainPending(state: ConnectionState): void {
    const ordered = Array.from(state.streams.values())
    state.ackFlushCursorStreamId = drainTerminalMultiplexRoundRobin({
      streams: ordered, cursorStreamId: state.ackFlushCursorStreamId, canContinue: () => !state.closed,
      drainOne: (s) => {
        if (s.closed || s.pendingOutput.length === 0) { return false }
        const chunk = s.pendingOutput[0]!
        if (!this.canSendFrame(state, s, chunk.bytes.byteLength)) { return false }
        s.pendingOutput.shift(); s.pendingOutputBytes -= chunk.bytes.byteLength
        this.sendPendingFrame(state, s, chunk, chunk.seq)
        return true
      }
    })
  }

  private closeStream(state: ConnectionState, stream: DeviceStreamState, reason?: string): void {
    if (stream.closed) { return }
    stream.closed = true
    this.sendFrame(state, stream.streamId, DeviceStreamOpcode.Close, encodeDeviceStreamJson({ reason: reason ?? 'server_close' }))
    this.detachStream(state, stream.streamId, reason)
  }

  private detachStream(state: ConnectionState, streamId: number, reason?: string): void {
    const stream = state.streams.get(streamId)
    if (!stream) { return }
    stream.closed = true; stream.unsubscribeSource(); stream.unregisterBinaryHandler()
    state.ackTotalInFlightBytes = Math.max(0, state.ackTotalInFlightBytes - stream.ackInFlightBytes)
    stream.ackInFlightBytes = 0; stream.pendingOutput = []; stream.pendingOutputBytes = 0
    state.streams.delete(streamId)
    decrementSubscriberCount(stream.sessionId)
    trackDeviceStreamClosed({ sessionId: stream.sessionId, deviceId: stream.deviceId, streamId: stream.streamId, reason })
  }

  private handleAck(state: ConnectionState, frame: DeviceStreamFrame): void {
    const ack = decodeDeviceStreamJson<{ bytes: number }>(frame.payload)
    if (!ack || typeof ack.bytes !== 'number' || ack.bytes <= 0) { return }
    const stream = state.streams.get(frame.streamId)
    if (!stream || stream.closed) { return }
    const acked = Math.min(stream.ackInFlightBytes, ack.bytes)
    stream.ackWindowBytes = Math.min(DEVICE_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES, stream.ackWindowBytes + acked)
    state.ackTotalWindowBytes = Math.min(DEVICE_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES, state.ackTotalWindowBytes + acked)
    stream.ackInFlightBytes -= acked
    state.ackTotalInFlightBytes = Math.max(0, state.ackTotalInFlightBytes - acked)
    this.drainPending(state)
  }

  private handleRequestKeyframe(state: ConnectionState, frame: DeviceStreamFrame): void {
    const stream = state.streams.get(frame.streamId)
    if (!stream || stream.closed) { return }
    trackDeviceStreamKeyframeRequested({ sessionId: stream.sessionId, deviceId: stream.deviceId, streamId: stream.streamId })
    stream.mediaSource.requestKeyframe?.()
  }

  private handlePauseResume(state: ConnectionState, frame: DeviceStreamFrame, paused: boolean): void {
    const stream = state.streams.get(frame.streamId)
    if (!stream || stream.closed) { return }
    stream.mediaSource.setPaused?.(paused)
  }

  private handleCloseStream(state: ConnectionState, frame: DeviceStreamFrame): void {
    const stream = state.streams.get(frame.streamId)
    if (!stream) { return }
    this.sendFrame(state, stream.streamId, DeviceStreamOpcode.Close, encodeDeviceStreamJson({ reason: 'client_close' }))
    this.detachStream(state, frame.streamId)
  }

  private handleStreamFrame(state: ConnectionState, stream: DeviceStreamState, frame: DeviceStreamFrame): void {
    if (stream.closed || state.closed) { return }
    switch (frame.opcode) {
      case DeviceStreamOpcode.Ack: this.handleAck(state, frame); break
      case DeviceStreamOpcode.RequestKeyframe: this.handleRequestKeyframe(state, frame); break
      case DeviceStreamOpcode.Pause: this.handlePauseResume(state, frame, true); break
      case DeviceStreamOpcode.Resume: this.handlePauseResume(state, frame, false); break
      case DeviceStreamOpcode.Close: this.handleCloseStream(state, frame); break
      // Client→server opcodes that are never received on per-stream handler (handled on stream 0)
      case DeviceStreamOpcode.Open: case DeviceStreamOpcode.Opened: case DeviceStreamOpcode.Metadata: case DeviceStreamOpcode.CodecConfig: case DeviceStreamOpcode.Frame: case DeviceStreamOpcode.Error: break
    }
  }

  private sendFrame(state: ConnectionState, streamId: number, opcode: DeviceStreamOpcode, payload: Uint8Array = new Uint8Array()): boolean {
    if (state.closed) { return false }
    try {
      const sent = state.transport.sendBinary(encodeDeviceStreamFrame(opcode, streamId, 0, payload))
      if (sent === false) { this.closeConnection(state.connectionId); return false }
      return true
    } catch { this.closeConnection(state.connectionId); return false }
  }
}

const serversByRuntimeId = new Map<string, DeviceStreamServer>()

export function registerDeviceStreamServer(runtime: OrcaRuntimeService): DeviceStreamServer {
  const server = new DeviceStreamServer(runtime)
  serversByRuntimeId.set(runtime.getRuntimeId(), server)
  return server
}

export function getDeviceStreamServer(runtime: OrcaRuntimeService): DeviceStreamServer | undefined {
  return serversByRuntimeId.get(runtime.getRuntimeId())
}
