import { BrowserWindow, type WebContents } from 'electron'
import { emulatorProbe } from '../emulator-probe'
import { AndroidDeviceMediaSource } from './android-device-media-source'
import type { DeviceMediaEvent } from '../../../shared/device-session-types'

// Tracks active IPC video stream subscriptions.
type Subscription = {
  owner: WebContents
  deviceId: string
  unsubscribe: () => void
  onOwnerDestroyed: () => void
}

const subscriptions = new Map<string, Subscription>()

function stopSubscription(streamId: string, owner?: WebContents): void {
  const sub = subscriptions.get(streamId)
  if (!sub || (owner && sub.owner !== owner)) {
    return
  }
  sub.unsubscribe()
  sub.owner.removeListener('destroyed', sub.onOwnerDestroyed)
  subscriptions.delete(streamId)
}

// Connect a renderer IPC channel to an Android device media source. Called by
// the emulator:videoStreamStart IPC handler. Returns the streamId.
export function connect(
  owner: WebContents,
  deviceId: string,
  streamId: string
): string {
  if (!BrowserWindow.fromWebContents(owner)) {
    throw new Error('Emulator video stream must originate from a BrowserWindow.')
  }
  const existing = subscriptions.get(streamId)
  if (existing && existing.owner !== owner) {
    throw new Error('Video stream id is already in use by another renderer')
  }
  stopSubscription(streamId, owner)

  emulatorProbe('video.subscribe', { deviceId })

  const onOwnerDestroyed = (): void => stopSubscription(streamId, owner)

  const pendingSub: Subscription = {
    owner,
    deviceId,
    unsubscribe: () => {},
    onOwnerDestroyed
  }
  subscriptions.set(streamId, pendingSub)

  // Defer subscription to next tick — matches the existing setTimeout(0) pattern
  // so the handler IPC response arrives before frame delivery can begin.
  setTimeout(() => {
    if (owner.isDestroyed() || subscriptions.get(streamId) !== pendingSub) {
      return
    }
    const source = new AndroidDeviceMediaSource(deviceId)
    const unsubscribe = source.subscribe((event) => {
      if (owner.isDestroyed()) {
        return
      }
      forwardEvent(owner, streamId, deviceId, event)
    })
    pendingSub.unsubscribe = unsubscribe
  }, 0)

  owner.once('destroyed', onOwnerDestroyed)
  return streamId
}

// Disconnect a video stream subscription. Called by emulator:videoStreamStop.
export function disconnect(streamId: string, owner?: WebContents): void {
  stopSubscription(streamId, owner)
}

// Forward a DeviceMediaEvent to the renderer via Electron IPC, preserving the
// exact payload shapes the preload bridge expects.
function forwardEvent(
  owner: WebContents,
  streamId: string,
  deviceId: string,
  event: DeviceMediaEvent
): void {
  switch (event.type) {
    case 'metadata':
      owner.send('emulator:videoStreamMeta', {
        streamId,
        deviceId,
        meta: { codecId: event.codec, width: event.width, height: event.height }
      })
      break
    case 'config':
      owner.send('emulator:videoStreamFrame', {
        streamId,
        deviceId,
        config: true,
        keyFrame: false,
        pts: String(event.pts),
        bytes: event.bytes
      })
      break
    case 'frame':
      owner.send('emulator:videoStreamFrame', {
        streamId,
        deviceId,
        config: false,
        keyFrame: event.keyFrame,
        pts: String(event.pts),
        bytes: event.bytes
      })
      break
    case 'error':
      // Not yet delivered to renderer over IPC — future phases may add an
      // emulator:videoStreamError channel. Log for diagnostics.
      emulatorProbe('video.error', { streamId, deviceId, code: event.code, message: event.message })
      break
    case 'closed':
      emulatorProbe('video.closed', { streamId, deviceId, reason: event.reason })
      break
  }
}

