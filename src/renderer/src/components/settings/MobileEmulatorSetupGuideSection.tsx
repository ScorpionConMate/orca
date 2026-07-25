import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { SearchableSetting } from './SearchableSetting'
import { SetupGuideCodeBlock } from './SetupGuideCodeBlock'
import { getMobileEmulatorSearchEntries } from './mobile-emulator-search'
import { translate } from '@/i18n/i18n'

const linuxCommands = [
  '# Java + scrcpy',
  'sudo apt update',
  'sudo apt install -y openjdk-17-jdk scrcpy',
  '',
  '# Android SDK via cmdline-tools',
  'mkdir -p ~/Android/Sdk/cmdline-tools',
  'cd ~/Android/Sdk/cmdline-tools',
  'wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip',
  'unzip commandlinetools-linux-*.zip',
  'mv cmdline-tools latest',
  '',
  '# Environment (add to ~/.bashrc)',
  'export ANDROID_HOME="$HOME/Android/Sdk"',
  'export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"',
  '',
  '# Accept licenses + install',
  'sdkmanager --licenses',
  'sdkmanager "platform-tools" "emulator" "platforms;android-34" "system-images;android-34;google_apis;x86_64"',
  '',
  '# Create AVD (per-worktree convention)',
  'avdmanager create avd -n orca_wt_<worktree-name> -k "system-images;android-34;google_apis;x86_64" -d pixel_6',
  '',
  '# Boot headless',
  'emulator -avd orca_wt_<worktree-name> -no-window -no-audio -gpu swiftshader_indirect &',
  'adb wait-for-device'
]

const macCommands = [
  '# Install Android Studio (easiest path)',
  '# https://developer.android.com/studio/install',
  '',
  '# Or use Homebrew for SDK + tools',
  'brew install --cask android-platform-tools',
  'brew install android-commandlinetools',
  '',
  '# Accept licenses',
  'sdkmanager --licenses',
  '',
  '# Create AVD (per-worktree convention)',
  'avdmanager create avd -n orca_wt_<worktree-name> -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_6',
  '',
  '# Boot headless',
  'emulator -avd orca_wt_<worktree-name> -no-window -no-audio -gpu swiftshader_indirect &',
  'adb wait-for-device'
]

const windowsCommands = [
  '# Install Android Studio (easiest path)',
  '# https://developer.android.com/studio/install',
  '',
  '# Or use winget for SDK tools',
  'winget install Google.AndroidTools.PlatformTools',
  '',
  '# Default SDK path (set ANDROID_HOME if different)',
  '# %LOCALAPPDATA%\\Android\\Sdk',
  '',
  '# Create AVD (per-worktree convention)',
  'avdmanager create avd -n orca_wt_<worktree-name> -k "system-images;android-34;google_apis;x86_64" -d pixel_6',
  '',
  '# Boot headless',
  'emulator -avd orca_wt_<worktree-name> -no-window -no-audio -gpu swiftshader_indirect &',
  'adb wait-for-device'
]

export function MobileEmulatorSetupGuideSection(): React.JSX.Element {
  const avdConventionText = translate(
    'auto.components.settings.MobileEmulatorSettingsPane.avdConvention',
    'Each worktree should use its own AVD. Name: orca_wt_<short-worktree-name> (e.g. orca_wt_feature-x). AVDs persist across sessions; remove them manually when no longer needed.'
  )
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.MobileEmulatorSettingsPane.setupGuide',
        'Setup Guide'
      )}
      description={translate(
        'auto.components.settings.MobileEmulatorSettingsPane.setupGuideDescription',
        'Install the Android SDK and create an AVD for mobile emulator streaming.'
      )}
      keywords={getMobileEmulatorSearchEntries().flatMap((entry) => entry.keywords ?? [])}
    >
      <Tabs defaultValue="linux" className="w-full">
        <TabsList>
          <TabsTrigger value="linux">
            {translate('auto.components.settings.MobileEmulatorSettingsPane.linuxTab', 'Linux')}
          </TabsTrigger>
          <TabsTrigger value="macos">
            {translate('auto.components.settings.MobileEmulatorSettingsPane.macOSTab', 'macOS')}
          </TabsTrigger>
          <TabsTrigger value="windows">
            {translate('auto.components.settings.MobileEmulatorSettingsPane.windowsTab', 'Windows')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="linux" className="pt-3">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.MobileEmulatorSettingsPane.linuxPrereqs',
                'Install Java, scrcpy, and the Android SDK via cmdline-tools.'
              )}
            </p>
            <SetupGuideCodeBlock lines={linuxCommands} />
            <p className="text-[11px] text-muted-foreground">{avdConventionText}</p>
          </div>
        </TabsContent>
        <TabsContent value="macos" className="pt-3">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.MobileEmulatorSettingsPane.macOSPrereqs',
                'The easiest path is Android Studio. See developer.android.com/studio/install.'
              )}
            </p>
            <SetupGuideCodeBlock lines={macCommands} />
            <p className="text-[11px] text-muted-foreground">{avdConventionText}</p>
          </div>
        </TabsContent>
        <TabsContent value="windows" className="pt-3">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.MobileEmulatorSettingsPane.windowsPrereqs',
                'The easiest path is Android Studio (developer.android.com/studio/install). The current build can consume an SDK at %LOCALAPPDATA%\\Android\\Sdk or ANDROID_HOME.'
              )}
            </p>
            <SetupGuideCodeBlock lines={windowsCommands} />
            <p className="text-[11px] text-muted-foreground">{avdConventionText}</p>
          </div>
        </TabsContent>
      </Tabs>
    </SearchableSetting>
  )
}
