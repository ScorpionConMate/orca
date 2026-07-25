// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { RemoteDeviceMediaSource } from './remote-device-media-source'
import type { DeviceSessionDescriptor, DeviceMediaEvent } from '../../../shared/device-session-types'
import {
  DeviceStreamOpcode,
  encodeDeviceStreamFrame,
  encodeDeviceStreamJson,
  encodeDeviceStreamHybridPayload
} from '../../../shared/device-stream-protocol'

function makeDescriptor(): DeviceSessionDescriptor {
  return {
    sessionId: 'test-session',
    provider: 'android-sdk',
    transport: 'runtime-websocket',
    deviceId: 'emulator-5554',
    displayName: 'Test Device',
    platform: 'android',
    capabilities: { video: true, input: true, install: false, launch: false, permissions: false, accessibilityTree: false, logs: false, rotate: false, clipboard: false, screenshots: false }
  }
}

function makePump() {
  const sendBinary = vi.fn()
  const handlers = new Map<number, (frame: { opcode: DeviceStreamOpcode; seq: number; payload: Uint8Array }) => void>()
  const registerStreamHandler = vi.fn((streamId: number, handler: (frame: { opcode: DeviceStreamOpcode; seq: number; payload: Uint8Array }) => void) => {
    handlers.set(streamId, handler)
    return () => handlers.delete(streamId)
  })
  return { sendBinary, registerStreamHandler, handlers }
}

describe('RemoteDeviceMediaSource', () => {
  it('replays cached metadata + config + last keyframe on subscribe (Finding 2)', () => {
    const pump = makePump()
    const source = new RemoteDeviceMediaSource(makeDescriptor(), pump, 1)

    // First subscribe — cache metadata, config, keyframe
    const sub1 = vi.fn()
    source.subscribe(sub1)

    const metaHandler = pump.handlers.get(1)!
    metaHandler({
      opcode: DeviceStreamOpcode.Metadata,
      seq: 0,
      payload: encodeDeviceStreamJson({ codec: 'h264', width: 1080, height: 1920 })
    })

    const configBytes = new Uint8Array([0, 0, 0, 1, 39, 100, 40])
    metaHandler({
      opcode: DeviceStreamOpcode.CodecConfig,
      seq: 0,
      payload: encodeDeviceStreamHybridPayload({ pts: '1000' }, configBytes.buffer as ArrayBuffer)
    })

    const keyFrameBytes = new Uint8Array([0, 0, 0, 1, 65, 200])
    metaHandler({
      opcode: DeviceStreamOpcode.Frame,
      seq: 1,
      payload: encodeDeviceStreamHybridPayload({ pts: '2000', keyFrame: true }, keyFrameBytes.buffer as ArrayBuffer)
    })

    expect(sub1).toHaveBeenCalledTimes(3)

    // Unsubscribe and resubscribe — should replay cached events
    sub1.mockReset()
    const sub2 = vi.fn()
    source.subscribe(sub2)

    expect(sub2).toHaveBeenCalledTimes(3)
    const calls = sub2.mock.calls.map((c) => (c[0] as DeviceMediaEvent).type)
    expect(calls).toEqual(['metadata', 'config', 'frame'])

    const metadataCall = sub2.mock.calls[0][0] as DeviceMediaEvent & { type: 'metadata' }
    expect(metadataCall.width).toBe(1080)
    expect(metadataCall.height).toBe(1920)

    const configCall = sub2.mock.calls[1][0] as DeviceMediaEvent & { type: 'config' }
    expect(configCall.pts).toBe(BigInt(1000))

    const frameCall = sub2.mock.calls[2][0] as DeviceMediaEvent & { type: 'frame' }
    expect(frameCall.keyFrame).toBe(true)
    expect(frameCall.seq).toBe(1)
  })

  it('requestKeyframe sends the correct binary frame', () => {
    const pump = makePump()
    const source = new RemoteDeviceMediaSource(makeDescriptor(), pump, 1)
    source.subscribe(vi.fn())

    source.requestKeyframe()

    // Should have sent a RequestKeyframe frame on stream 1
    const expected = encodeDeviceStreamFrame(DeviceStreamOpcode.RequestKeyframe, 1, 0, new Uint8Array())
    expect(pump.sendBinary).toHaveBeenCalled()
    const sent = pump.sendBinary.mock.calls[0][0] as Uint8Array
    expect(sent).toEqual(expected)
  })

  it('setPaused sends Pause and Resume frames', () => {
    const pump = makePump()
    const source = new RemoteDeviceMediaSource(makeDescriptor(), pump, 1)
    source.subscribe(vi.fn())

    source.setPaused(true)
    const pauseExpected = encodeDeviceStreamFrame(DeviceStreamOpcode.Pause, 1, 0, new Uint8Array())
    expect(pump.sendBinary).toHaveBeenCalledWith(pauseExpected)

    source.setPaused(false)
    const resumeExpected = encodeDeviceStreamFrame(DeviceStreamOpcode.Resume, 1, 0, new Uint8Array())
    expect(pump.sendBinary).toHaveBeenCalledWith(resumeExpected)
  })

  it('parses pts string to bigint (Finding 7)', () => {
    const pump = makePump()
    const source = new RemoteDeviceMediaSource(makeDescriptor(), pump, 1)
    const listener = vi.fn()
    source.subscribe(listener)

    const ptsStr = '123456789012345'
    const configBytes = new Uint8Array([1, 2, 3])
    pump.handlers.get(1)!({
      opcode: DeviceStreamOpcode.CodecConfig,
      seq: 0,
      payload: encodeDeviceStreamHybridPayload({ pts: ptsStr }, configBytes.buffer as ArrayBuffer)
    })

    const event = listener.mock.calls[0][0] as DeviceMediaEvent & { type: 'config' }
    expect(event.pts).toBe(BigInt(ptsStr))
  })

  it('handles jsonLen === 0 (Finding 8) — Ack/Close/Error with no payload', () => {
    const pump = makePump()
    const source = new RemoteDeviceMediaSource(makeDescriptor(), pump, 1)
    const listener = vi.fn()
    source.subscribe(listener)

    // Ack with empty payload — should not crash or emit a metadata/config/frame event
    pump.handlers.get(1)!({
      opcode: DeviceStreamOpcode.Ack,
      seq: 5,
      payload: new Uint8Array()
    })
    expect(listener).not.toHaveBeenCalled()

    // Close with empty payload
    pump.handlers.get(1)!({
      opcode: DeviceStreamOpcode.Close,
      seq: 0,
      payload: new Uint8Array()
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as DeviceMediaEvent).type).toBe('closed')
  })

  it('handles Close and Error events', () => {
    const pump = makePump()
    const source = new RemoteDeviceMediaSource(makeDescriptor(), pump, 1)
    const listener = vi.fn()
    source.subscribe(listener)

    pump.handlers.get(1)!({
      opcode: DeviceStreamOpcode.Error,
      seq: 0,
      payload: encodeDeviceStreamJson({ code: 'test_error', message: 'Something went wrong' })
    })

    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0][0] as DeviceMediaEvent & { type: 'error' }
    expect(event.type).toBe('error')
    expect(event.code).toBe('test_error')
    expect(event.message).toBe('Something went wrong')

    listener.mockReset()
    pump.handlers.get(1)!({
      opcode: DeviceStreamOpcode.Close,
      seq: 0,
      payload: encodeDeviceStreamJson({ reason: 'server_shutdown' })
    })

    expect(listener).toHaveBeenCalledTimes(1)
    const closeEvent = listener.mock.calls[0][0] as DeviceMediaEvent & { type: 'closed' }
    expect(closeEvent.type).toBe('closed')
    expect(closeEvent.reason).toBe('server_shutdown')
  })
})
