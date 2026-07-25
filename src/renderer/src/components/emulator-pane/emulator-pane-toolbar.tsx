import { Home, Loader2, Power, RotateCw, Smartphone } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SimulatorDeviceRow } from './emulator-pane-types'
import { translate } from '@/i18n/i18n'
import type { DeviceStreamClientState } from './device-stream-client'

type EmulatorPaneToolbarProps = {
  displayName: string
  isLive: boolean
  loading: boolean
  devices: SimulatorDeviceRow[]
  selectedUdid: string | null
  onSelectDevice: (udid: string) => void
  onAttach: () => void
  onShutdown: () => void
  onHome: () => void
  onRotate: () => void
  /** Remote stream state — when set, overrides the isLive/loading rendering for the status chip. */
  remoteStreamState?: DeviceStreamClientState | null
}

export function EmulatorPaneToolbar({
  displayName,
  isLive,
  loading,
  devices,
  selectedUdid,
  onSelectDevice,
  onAttach,
  onShutdown,
  onHome,
  onRotate,
  remoteStreamState
}: EmulatorPaneToolbarProps) {
  const useRemote = remoteStreamState !== undefined && remoteStreamState !== null

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <Smartphone className="size-4 shrink-0 text-primary" />
      <span className="truncate font-medium">{displayName}</span>
      {/* Status badge — renders per spec */}
      {useRemote ? (
        <RemoteStatusBadge state={remoteStreamState} />
      ) : (
        <LocalStatusBadge isLive={isLive} loading={loading} />
      )}
      <div className="flex-1" />
      <Select
        value={selectedUdid ?? ''}
        onValueChange={onSelectDevice}
        disabled={loading || devices.length === 0 || useRemote}
      >
        <SelectTrigger className="h-7 w-[180px] text-xs">
          <SelectValue
            placeholder={translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.3d836b879c',
              'Choose emulator'
            )}
          />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
          {devices.map((d) => (
            <SelectItem key={d.udid} value={d.udid} className="text-xs">
              {d.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onRotate}
            disabled={!canRotate(isLive, loading, remoteStreamState)}
            aria-label={translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.6bd8dff42a',
              'Rotate'
            )}
          >
            <RotateCw className="size-3.5" />
            <span className="hidden sm:inline">
              {translate(
                'auto.components.emulator.pane.emulator.pane.toolbar.6bd8dff42a',
                'Rotate'
              )}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate('auto.components.emulator.pane.emulator.pane.toolbar.6bd8dff42a', 'Rotate')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            className="size-7"
            onClick={onHome}
            disabled={!canHome(isLive, loading, remoteStreamState)}
            aria-label={translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.e7a0d1897e',
              'Home'
            )}
          >
            <Home className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate('auto.components.emulator.pane.emulator.pane.toolbar.e7a0d1897e', 'Home')}
        </TooltipContent>
      </Tooltip>
      {canShowShutdown(isLive, remoteStreamState) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onShutdown}
              disabled={loading}
              aria-label={translate(
                'auto.components.emulator.pane.emulator.pane.toolbar.06e10d7356',
                'Shut down emulator'
              )}
            >
              <Power className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.06e10d7356',
              'Shut down emulator'
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={loading ? 'ghost' : 'default'}
          className={cn('h-7 px-2 text-xs', loading && 'text-muted-foreground')}
          onClick={onAttach}
          disabled={loading || devices.length === 0 || isConnectDisabled(remoteStreamState)}
        >
          {isConnectWorking(loading, remoteStreamState) ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              {translate(
                'auto.components.emulator.pane.emulator.pane.toolbar.868c0f2938',
                'Working…'
              )}
            </>
          ) : (
            translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.81b3571a07',
              'Connect'
            )
          )}
        </Button>
      )}
    </div>
  )
}

// ── Status badge components ─────────────────────────────────────

function LocalStatusBadge({
  isLive,
  loading
}: {
  isLive: boolean
  loading: boolean
}) {
  if (isLive) {
    return (
      <Badge variant="secondary">
        {translate('auto.components.emulator.pane.emulator.pane.toolbar.local.live', 'Live')}
      </Badge>
    )
  }
  if (loading) {
    return (
      <Badge variant="secondary">
        <Loader2 className="size-3 animate-spin" />
        {translate(
          'auto.components.emulator.pane.emulator.pane.toolbar.local.connecting',
          'Connecting'
        )}
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      {translate(
        'auto.components.emulator.pane.emulator.pane.toolbar.local.offline',
        'Not connected'
      )}
    </Badge>
  )
}

function RemoteStatusBadge({ state }: { state: DeviceStreamClientState }) {
  switch (state) {
    case 'connecting':
      return (
        <Badge variant="secondary">
          <Loader2 className="size-3 animate-spin" />
          {translate(
            'auto.components.emulator.pane.emulator.pane.toolbar.remote.connecting',
            'Connecting'
          )}
        </Badge>
      )
    case 'streaming':
      return (
        <Badge variant="secondary">
          {translate(
            'auto.components.emulator.pane.emulator.pane.toolbar.remote.live',
            'Live'
          )}
        </Badge>
      )
    case 'recovering':
      return (
        <Badge variant="outline">
          <Loader2 className="size-3 animate-spin" />
          {translate(
            'auto.components.emulator.pane.emulator.pane.toolbar.remote.recovering',
            'Recovering'
          )}
        </Badge>
      )
    case 'disconnected':
    case 'fallback':
      return (
        <Badge variant="destructive">
          {translate(
            'auto.components.emulator.pane.emulator.pane.toolbar.remote.disconnected',
            'Disconnected'
          )}
        </Badge>
      )
  }
}

// ── Affordance helpers per spec ─────────────────────────────────

function canRotate(
  isLive: boolean,
  loading: boolean,
  remoteState: DeviceStreamClientState | null | undefined
): boolean {
  if (remoteState == null) {
    return isLive && !loading
  }
  return remoteState === 'streaming' || remoteState === 'recovering'
}

function canHome(
  isLive: boolean,
  loading: boolean,
  remoteState: DeviceStreamClientState | null | undefined
): boolean {
  return canRotate(isLive, loading, remoteState)
}

function canShowShutdown(
  isLive: boolean,
  remoteState: DeviceStreamClientState | null | undefined
): boolean {
  if (remoteState == null) {
    return isLive
  }
  return remoteState === 'streaming' || remoteState === 'recovering'
}

function isConnectWorking(
  loading: boolean,
  remoteState: DeviceStreamClientState | null | undefined
): boolean {
  if (remoteState != null) {
    return remoteState === 'connecting'
  }
  return loading
}

function isConnectDisabled(
  remoteState: DeviceStreamClientState | null | undefined
): boolean {
  if (remoteState == null) {
    return false
  }
  return (
    remoteState === 'connecting' ||
    remoteState === 'streaming' ||
    remoteState === 'recovering'
  )
}
