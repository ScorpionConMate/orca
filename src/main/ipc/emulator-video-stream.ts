import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  connect,
  disconnect
} from '../emulator/device-session/local-ipc-device-transport'

// Bridges the main-process scrcpy video registry to renderer subscribers. The
// renderer calls emulator:videoStreamStart with a deviceId; meta + H.264 access
// units arrive on emulator:videoStreamMeta / emulator:videoStreamFrame. Mirrors
// the MJPEG emulator-frame-stream handler but for the Android H.264 path.
//
// Thin IPC surface — subscription lifecycle and event forwarding live in the
// local-ipc-device-transport module.
export function registerEmulatorVideoStreamHandlers(): void {
  ipcMain.handle(
    'emulator:videoStreamStart',
    (event, args: { deviceId: string; streamId?: string }) => {
      if (typeof args?.deviceId !== 'string') {
        throw new Error('Emulator video stream requires a deviceId string.')
      }
      const streamId = args.streamId ?? randomUUID()
      connect(event.sender, args.deviceId, streamId)
      return { streamId }
    }
  )

  ipcMain.handle('emulator:videoStreamStop', (event, args: { streamId: string }) => {
    disconnect(args.streamId, event.sender)
  })
}
