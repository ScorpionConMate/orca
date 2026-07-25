import { Loader2 } from 'lucide-react'
import { useEffect, type CSSProperties } from 'react'
import { useEmulatorFrameStream } from './use-emulator-frame-stream'
import { useEmulatorVideoStream } from './use-emulator-video-stream'
import { translate } from '@/i18n/i18n'
import type { VisualStreamGeometry } from './emulator-device-frame-layout'
import {
  useDeviceStreamClient,
  type DeviceStreamClientState
} from './device-stream-client'
import type { DeviceSessionDescriptor } from '../../../../shared/device-session-types'
import { Button } from '@/components/ui/button'

type StreamSize = {
  height: number
  width: number
}

type EmulatorScreenStreamContentProps = {
  loading: boolean
  onStreamError: () => void
  onStreamSize: (size: StreamSize) => void
  previewUrl?: string
  screenAspectRatio?: number
  showStream: boolean
  streamError: boolean
  streamKey?: string
  streamRotation?: VisualStreamGeometry['streamRotation']
  // Remote device streaming
  remoteSessionDescriptor?: DeviceSessionDescriptor | null
  remoteDeviceStreamingEnabled?: boolean
  onRemoteStreamStateChange?: (state: DeviceStreamClientState | null) => void
}

// Android sessions stream H.264 over scrcpy://<serial>; iOS uses an MJPEG http URL.
const SCRCPY_PREFIX = 'scrcpy://'

export function EmulatorScreenStreamContent({
  loading,
  onStreamError,
  onStreamSize,
  previewUrl,
  screenAspectRatio = 9 / 19,
  showStream,
  streamError,
  streamKey,
  streamRotation = 0,
  remoteSessionDescriptor,
  remoteDeviceStreamingEnabled = false,
  onRemoteStreamStateChange
}: EmulatorScreenStreamContentProps) {
  const androidDeviceId =
    previewUrl && previewUrl.startsWith(SCRCPY_PREFIX)
      ? previewUrl.slice(SCRCPY_PREFIX.length)
      : null

  // Remote device stream path
  const useRemote = Boolean(
    remoteSessionDescriptor &&
      remoteDeviceStreamingEnabled &&
      showStream &&
      !androidDeviceId
  )
  const remote = useDeviceStreamClient({
    sessionDescriptor: useRemote ? remoteSessionDescriptor! : null,
    enabled: useRemote,
    onSize: (size) => onStreamSize(size)
  })

  // Lift remote state up for the toolbar badge
  useEffect(() => {
    if (useRemote) {
      onRemoteStreamStateChange?.(remote.state)
    } else {
      onRemoteStreamStateChange?.(null)
    }
  }, [remote.state, useRemote, onRemoteStreamStateChange])

  const video = useEmulatorVideoStream(
    androidDeviceId ?? undefined,
    streamKey,
    showStream && Boolean(androidDeviceId),
    onStreamSize
  )
  const frameStream = useEmulatorFrameStream(
    androidDeviceId ? undefined : previewUrl,
    streamKey,
    showStream && Boolean(previewUrl) && !androidDeviceId
  )

  useEffect(() => {
    if (frameStream.error || video.error || remote.error) {
      onStreamError()
    }
  }, [frameStream.error, video.error, remote.error, onStreamError])

  const mediaStyle = resolveStreamMediaStyle(streamRotation, screenAspectRatio)
  const mediaClassName =
    streamRotation === 0
      ? 'block h-full w-full bg-black object-contain'
      : 'absolute left-1/2 top-1/2 block max-w-none bg-black object-contain'

  // Remote device streaming states
  if (useRemote) {
    switch (remote.state) {
      case 'fallback':
        return (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/20 text-muted-foreground">
            <span className="px-6 text-center text-xs">
              {translate(
                'auto.components.emulator.pane.emulator.screen.stream.content.remote.fallback.title',
                'Remote device streaming is not available.'
              )}
            </span>
            <span className="px-6 text-center text-xs">
              {translate(
                'auto.components.emulator.pane.emulator.screen.stream.content.remote.fallback.hint',
                'Enable the feature or connect a local device.'
              )}
            </span>
          </div>
        )

      case 'connecting':
        return (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/20 transition-opacity duration-150">
            <Loader2 className="size-6 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">
              {translate(
                'auto.components.emulator.pane.emulator.screen.stream.content.remote.connecting',
                'Connecting to remote device…'
              )}
            </span>
          </div>
        )

      case 'recovering':
        return (
          <div className="relative h-full w-full">
            <canvas
              ref={remote.canvasRef}
              className={mediaClassName}
              style={mediaStyle}
              aria-label={translate(
                'auto.components.emulator.pane.emulator.screen.stream.content.5ee64cd44e',
                'Emulator screen'
              )}
            />
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full border border-border bg-muted/80 px-2.5 py-1 text-[11px] text-muted-foreground transition-opacity duration-150">
              <Loader2 className="size-3 animate-spin" />
              <span>
                {translate(
                  'auto.components.emulator.pane.emulator.screen.stream.content.remote.recovering',
                  'Recovering stream…'
                )}
              </span>
            </div>
          </div>
        )

      case 'disconnected':
        return (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/20 transition-opacity duration-150">
            <span className="px-6 text-center text-xs">
              {translate(
                'auto.components.emulator.pane.emulator.screen.stream.content.remote.disconnected.title',
                'Remote stream disconnected'
              )}
            </span>
            <span className="px-6 text-center text-xs">
              {translate(
                'auto.components.emulator.pane.emulator.screen.stream.content.remote.disconnected.hint',
                'Host closed the session or the connection was lost.'
              )}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={remote.retry}
            >
              {translate(
                'auto.components.emulator.pane.emulator.screen.stream.content.remote.disconnected.retry',
                'Retry'
              )}
            </Button>
          </div>
        )

      case 'streaming':
        return (
          <canvas
            ref={remote.canvasRef}
            className={mediaClassName}
            style={mediaStyle}
            aria-label={translate(
              'auto.components.emulator.pane.emulator.screen.stream.content.5ee64cd44e',
              'Emulator screen'
            )}
          />
        )
    }
  }

  // Existing local path (unchanged)
  if (androidDeviceId && showStream && !video.error) {
    return (
      <canvas
        ref={video.canvasRef}
        className={mediaClassName}
        style={mediaStyle}
        aria-label={translate(
          'auto.components.emulator.pane.emulator.screen.stream.content.5ee64cd44e',
          'Emulator screen'
        )}
      />
    )
  }

  if (showStream && frameStream.frameUrl) {
    return (
      <img
        key={`${previewUrl}::${streamKey ?? ''}`}
        src={frameStream.frameUrl}
        alt={translate(
          'auto.components.emulator.pane.emulator.screen.stream.content.5ee64cd44e',
          'Emulator screen'
        )}
        className={mediaClassName}
        draggable={false}
        style={mediaStyle}
        onError={onStreamError}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          if (naturalWidth <= 0 || naturalHeight <= 0) {
            return
          }
          onStreamSize({ width: naturalWidth, height: naturalHeight })
        }}
      />
    )
  }

  const waitingForFrame = showStream && !frameStream.error && !video.error
  const displayError = streamError || Boolean(frameStream.error) || Boolean(video.error)

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/20 text-muted-foreground">
      {loading || waitingForFrame ? (
        <>
          <Loader2 className="size-6 animate-spin text-primary" />
          <span className="text-xs">
            {translate(
              'auto.components.emulator.pane.emulator.screen.stream.content.5f818f12ab',
              'Connecting emulator…'
            )}
          </span>
        </>
      ) : displayError ? (
        <span className="px-6 text-center text-xs">
          {translate(
            'auto.components.emulator.pane.emulator.screen.stream.content.36841af608',
            'Stream disconnected'
          )}
        </span>
      ) : (
        <span className="px-6 text-center text-xs">
          {translate(
            'auto.components.emulator.pane.emulator.screen.stream.content.8b1a0d8694',
            'Emulator preview'
          )}
        </span>
      )}
    </div>
  )
}

function resolveStreamMediaStyle(
  streamRotation: VisualStreamGeometry['streamRotation'],
  screenAspectRatio: number
): CSSProperties | undefined {
  if (streamRotation === 0 || screenAspectRatio <= 0) {
    return undefined
  }
  return {
    height: `${100 * screenAspectRatio}%`,
    transform: `translate(-50%, -50%) rotate(${streamRotation}deg)`,
    transformOrigin: 'center',
    width: `${100 / screenAspectRatio}%`
  }
}
