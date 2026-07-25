import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { GlobalSettings, MobileEmulatorProvider } from '../../../../shared/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

type EmulatorSourceSelectorProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EmulatorSourceSelector({
  settings,
  updateSettings
}: EmulatorSourceSelectorProps): React.JSX.Element {
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const providerKind = settings.mobileEmulatorProvider?.kind ?? 'follow-runtime'
  const providerRuntimeId =
    settings.mobileEmulatorProvider?.kind === 'remote'
      ? settings.mobileEmulatorProvider.runtimeEnvironmentId
      : null
  const hasRemoteRuntimes = runtimeEnvironments.some((env) => env.endpoints.length > 0)

  const setProviderKind = useCallback(
    (kind: MobileEmulatorProvider['kind']) => {
      if (kind === 'follow-runtime') {
        updateSettings({ mobileEmulatorProvider: { kind: 'follow-runtime' } })
      } else if (kind === 'local') {
        updateSettings({ mobileEmulatorProvider: { kind: 'local' } })
      } else if (kind === 'remote') {
        const environments = useAppStore.getState().runtimeEnvironments
        const firstId = environments.length > 0 ? environments[0].id : '__no_environments__'
        updateSettings({
          mobileEmulatorProvider: {
            kind: 'remote',
            runtimeEnvironmentId: providerRuntimeId || firstId
          }
        })
      }
    },
    [updateSettings, providerRuntimeId]
  )

  const handleProviderRuntimeChange = useCallback(
    (runtimeEnvironmentId: string) => {
      updateSettings({
        mobileEmulatorProvider: { kind: 'remote', runtimeEnvironmentId }
      })
    },
    [updateSettings]
  )

  return (
    <div className="space-y-3">
      <div className="space-y-3" role="radiogroup" aria-label={translate('auto.components.settings.EmulatorSourceSelector.sourceLabel', 'Emulator source')}>
        <SourceOption
          kind="follow-runtime"
          currentKind={providerKind}
          onSelect={setProviderKind}
          label={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.followRuntime',
            'Follow active runtime'
          )}
          description={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.followRuntimeDesc',
            'Use whichever runtime this workspace is connected to.'
          )}
        />
        <SourceOption
          kind="local"
          currentKind={providerKind}
          onSelect={setProviderKind}
          label={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.localSDK',
            'Local SDK'
          )}
          description={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.localSDKDesc',
            "Always use this machine's Android SDK."
          )}
        />
        <label
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
            providerKind === 'remote'
              ? 'border-foreground/20 bg-accent/10'
              : 'border-border/50 hover:border-border',
            !hasRemoteRuntimes && 'cursor-not-allowed opacity-50'
          )}
        >
          <input
            type="radio"
            name="emulatorSource"
            className="mt-0.5 size-4 accent-foreground"
            checked={providerKind === 'remote'}
            onChange={() => setProviderKind('remote')}
            disabled={!hasRemoteRuntimes}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div>
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.MobileEmulatorSettingsPane.specificRemote',
                  'Specific remote runtime'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.MobileEmulatorSettingsPane.specificRemoteDesc',
                  "Always use this runtime's host."
                )}
              </p>
            </div>
            {providerKind === 'remote' && hasRemoteRuntimes ? (
              <Select
                value={providerRuntimeId ?? undefined}
                onValueChange={handleProviderRuntimeChange}
              >
                <SelectTrigger size="sm" className="w-56 max-w-full">
                  <SelectValue
                    placeholder={translate(
                      'auto.components.settings.MobileEmulatorSettingsPane.selectRuntime',
                      'Select runtime environment'
                    )}
                  />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {runtimeEnvironments
                    .filter((env) => env.endpoints.length > 0)
                    .map((env) => (
                      <SelectItem key={env.id} value={env.id} textValue={env.name}>
                        {env.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.MobileEmulatorSettingsPane.perWorktreeNote',
          'Per-workspace setting. The SDK must be installed on the chosen host.'
        )}
      </p>
    </div>
  )
}

function SourceOption({
  kind,
  currentKind,
  onSelect,
  label,
  description
}: {
  kind: MobileEmulatorProvider['kind']
  currentKind: string
  onSelect: (kind: MobileEmulatorProvider['kind']) => void
  label: string
  description: string
}): React.JSX.Element {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
        kind === currentKind
          ? 'border-foreground/20 bg-accent/10'
          : 'border-border/50 hover:border-border'
      )}
    >
      <input
        type="radio"
        name="emulatorSource"
        className="mt-0.5 size-4 accent-foreground"
        checked={kind === currentKind}
        onChange={() => onSelect(kind)}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  )
}
