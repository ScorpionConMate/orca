// Versioned binary wire protocol for device video streams (H.264/MJPEG).
// Mirrors terminal-stream-protocol.ts structure with kind byte 'd' (0x64).

const DEVICE_STREAM_KIND = 0x64
const DEVICE_STREAM_VERSION = 1
export const DEVICE_STREAM_HEADER_BYTES = 16
export const DEVICE_STREAM_MAX_FRAME_BYTES = 4 * 1024 * 1024

export enum DeviceStreamOpcode {
  Open = 1,
  Opened = 2,
  Metadata = 3,
  CodecConfig = 4,
  Frame = 5,
  Ack = 6,
  RequestKeyframe = 7,
  Pause = 8,
  Resume = 9,
  Close = 10,
  Error = 11
}

export type DeviceStreamFrame = {
  opcode: DeviceStreamOpcode
  streamId: number
  seq: number
  payload: Uint8Array
}

export function encodeDeviceStreamFrame(opcode: DeviceStreamOpcode, streamId: number, seq: number, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > DEVICE_STREAM_MAX_FRAME_BYTES) {
    throw new Error('device_stream_payload_too_large')
  }
  const out = new Uint8Array(DEVICE_STREAM_HEADER_BYTES + payload.length)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint8(0, DEVICE_STREAM_KIND)
  view.setUint8(1, DEVICE_STREAM_VERSION)
  view.setUint8(2, opcode)
  view.setUint8(3, 0) // reserved
  view.setUint32(4, streamId, true)
  const resolvedSeq = Math.max(0, Math.floor(seq))
  view.setUint32(8, Math.floor(resolvedSeq / 0x100000000), true)
  view.setUint32(12, resolvedSeq >>> 0, true)
  out.set(payload, DEVICE_STREAM_HEADER_BYTES)
  return out
}

export function decodeDeviceStreamFrame(bytes: Uint8Array): DeviceStreamFrame | null {
  if (bytes.length < DEVICE_STREAM_HEADER_BYTES) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint8(0) !== DEVICE_STREAM_KIND || view.getUint8(1) !== DEVICE_STREAM_VERSION) {
    return null
  }
  const opcode = view.getUint8(2)
  if (!isDeviceStreamOpcode(opcode)) {
    return null
  }
  const high = view.getUint32(8, true)
  const low = view.getUint32(12, true)
  return {
    opcode,
    streamId: view.getUint32(4, true),
    seq: high * 0x100000000 + low,
    payload: bytes.slice(DEVICE_STREAM_HEADER_BYTES)
  }
}

// JSON payload helpers — mirrors terminal-stream-protocol JSON helpers.
export function encodeDeviceStreamJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

export function decodeDeviceStreamJson<T>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as T
  } catch {
    return null
  }
}

// Combined header+body encoding for frames with metadata + binary data.
// Payload layout: [4-byte JSON length LE][JSON metadata UTF-8][binary bytes]
// This keeps metadata inspectable on the wire while carrying arbitrary binary payload.
const METADATA_HEADER_BYTES = 4

export function encodeDeviceStreamHybridPayload(metadata: object, bytes: ArrayBuffer): Uint8Array {
  const jsonPart = new TextEncoder().encode(JSON.stringify(metadata))
  const out = new Uint8Array(METADATA_HEADER_BYTES + jsonPart.length + bytes.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, jsonPart.length, true)
  out.set(jsonPart, METADATA_HEADER_BYTES)
  out.set(new Uint8Array(bytes), METADATA_HEADER_BYTES + jsonPart.length)
  return out
}

export function decodeDeviceStreamHybridPayload(payload: Uint8Array): { metadata: Record<string, unknown> | null; bytes: ArrayBuffer } {
  if (payload.length < METADATA_HEADER_BYTES) {
    return { metadata: null, bytes: new ArrayBuffer(0) }
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const jsonLen = view.getUint32(0, true)
  if (jsonLen < 1 || METADATA_HEADER_BYTES + jsonLen > payload.length) {
    return { metadata: null, bytes: payload.slice(METADATA_HEADER_BYTES).buffer }
  }
  let metadata: Record<string, unknown> | null = null
  try {
    metadata = JSON.parse(
      new TextDecoder().decode(payload.slice(METADATA_HEADER_BYTES, METADATA_HEADER_BYTES + jsonLen))
    )
  } catch {
    metadata = null
  }
  const binaryBytes = payload.slice(METADATA_HEADER_BYTES + jsonLen)
  return { metadata, bytes: binaryBytes.buffer as ArrayBuffer }
}

function isDeviceStreamOpcode(value: number): value is DeviceStreamOpcode {
  return (
    value === DeviceStreamOpcode.Open ||
    value === DeviceStreamOpcode.Opened ||
    value === DeviceStreamOpcode.Metadata ||
    value === DeviceStreamOpcode.CodecConfig ||
    value === DeviceStreamOpcode.Frame ||
    value === DeviceStreamOpcode.Ack ||
    value === DeviceStreamOpcode.RequestKeyframe ||
    value === DeviceStreamOpcode.Pause ||
    value === DeviceStreamOpcode.Resume ||
    value === DeviceStreamOpcode.Close ||
    value === DeviceStreamOpcode.Error
  )
}
