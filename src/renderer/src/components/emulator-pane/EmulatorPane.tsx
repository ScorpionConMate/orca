import { useCallback, useState } from 'react'
import type { Tab } from '../../../../shared/types'
import type { DeviceSessionDescriptor } from '../../../../shared/device-session-types'
import { EmulatorPaneToolbar } from './emulator-pane-toolbar'
import { EmulatorDeviceFrame } from './emulator-device-frame'
import { MobileEmulatorAgentSetupGuideLayer } from './MobileEmulatorAgentSetupGuideLayer'
import { useEmulatorPaneSession } from './use-emulator-pane-session'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { DeviceStreamClientState } from './device-stream-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

type EmulatorPaneProps = {
  tab?: Tab
  worktreeId: string
  /** When false, pane was pre-mounted for split safety and should not auto-attach until active. */
  isActive?: boolean
}

export default function EmulatorPane({ tab, worktreeId, isActive = true }: EmulatorPaneProps) {
  const {
    devices,
    selectedUdid,
    setSelectedUdid,
    loading,
    error: localError,
    attach,
    shutdown,
    sendTap,
    sendButton,
    sendGesture,
    sendRotate,
    displayName,
    previewUrl,
    wsUrl,
    streamKey,
    isLive,
    visualOrientation
  } = useEmulatorPaneSession({
    worktreeId,
    tabId: tab?.id,
    autoAttachOnMount: isActive
  })

  const remoteDeviceStreamingEnabled = useAppStore(
    (s) => s.settings?.experimentalRemoteDeviceStreaming === true
  )
  // Why: lifted remote state so EmulatorPaneToolbar shows the matching badge
  const [remoteStreamState, setRemoteStreamState] =
    useState<DeviceStreamClientState | null>(null)

  // Phase 4: remote attach descriptor
  const [remoteSessionDescriptor, setRemoteSessionDescriptor] =
    useState<DeviceSessionDescriptor | null>(null)
  const [remoteAttachBusy, setRemoteAttachBusy] = useState(false)

  const remoteAttach = useCallback(async (deviceId: string) => {
    setRemoteAttachBusy(true)
    try {
      const settings = useAppStore.getState().settings
      if (!settings?.activeRuntimeEnvironmentId?.trim()) { return }
      const target = { kind: 'environment' as const, environmentId: settings.activeRuntimeEnvironmentId.trim() }
      const sessions = await callRuntimeRpc<DeviceSessionDescriptor[]>(target, 'emulator.session.list', {})
      const sid = `remote-${deviceId}-${Date.now()}`
      const descriptor: DeviceSessionDescriptor | null = sessions && sessions.length > 0
        ? sessions.at(0)!
        : await callRuntimeRpc<DeviceSessionDescriptor>(target, 'emulator.stream.open', { sessionId: sid, deviceId })
      if (descriptor) { setRemoteSessionDescriptor(descriptor) }
    } catch {
      setRemoteStreamState('disconnected')
    } finally {
      setRemoteAttachBusy(false)
    }
  }, [])

  const error = localError || (remoteStreamState === 'disconnected' ? '' : null)

  return (
    <div
      data-emulator-pane
      className="flex h-full min-h-0 flex-col bg-background text-sm text-foreground"
    >
      <EmulatorPaneToolbar
        displayName={displayName}
        isLive={isLive}
        loading={loading || remoteAttachBusy}
        devices={devices}
        selectedUdid={selectedUdid}
        onSelectDevice={(udid) => {
          setSelectedUdid(udid)
          if (remoteDeviceStreamingEnabled) {
            void remoteAttach(udid)
          } else {
            void attach(udid)
          }
        }}
        onAttach={() => {
          if (remoteDeviceStreamingEnabled && selectedUdid) {
            void remoteAttach(selectedUdid)
          } else {
            void attach(selectedUdid ?? undefined)
          }
        }}
        onShutdown={() => void shutdown(selectedUdid ?? undefined)}
        onHome={() => void sendButton('home')}
        onRotate={() => void sendRotate()}
        remoteStreamState={remoteStreamState}
      />

      {error && !remoteDeviceStreamingEnabled ? (
        <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted px-3 py-6">
        <MobileEmulatorAgentSetupGuideLayer isActive={isActive} worktreeId={worktreeId}>
          {!isLive && !loading && !remoteDeviceStreamingEnabled ? (
            <p className="mb-4 text-center text-xs text-muted-foreground">
              {translate(
                'auto.components.emulator.pane.EmulatorPane.59b08fa031',
                'No emulator connected'
              )}
            </p>
          ) : null}
          <EmulatorDeviceFrame
            previewUrl={previewUrl}
            wsUrl={wsUrl}
            streamKey={streamKey}
            deviceName={displayName}
            loading={loading}
            isLive={isLive}
            visualOrientation={visualOrientation}
            isActive={isActive}
            onTap={(x, y) => void sendTap(x, y)}
            onGesture={(points) => void sendGesture(points)}
            remoteSessionDescriptor={remoteSessionDescriptor}
            remoteDeviceStreamingEnabled={remoteDeviceStreamingEnabled}
            onRemoteStreamStateChange={setRemoteStreamState}
          />
        </MobileEmulatorAgentSetupGuideLayer>
      </div>
    </div>
  )
}
