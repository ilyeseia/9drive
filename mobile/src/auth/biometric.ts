import * as LocalAuthentication from 'expo-local-authentication';
import { readPref, writePref } from '../core/prefs';
import { DEFAULT_SETTINGS, TIMEOUT_CHOICES, type Authenticator, type Availability, type LockSettings } from './lock';

/**
 * Device authentication through the OS: Face ID / Touch ID / Android biometrics, falling back to the device
 * passcode (so a user whose biometrics fail is not locked out of their own phone). The OS performs the check;
 * the app never sees biometric data.
 */
export class DeviceAuthenticator implements Authenticator {
  async availability(): Promise<Availability> {
    try {
      if (!(await LocalAuthentication.hasHardwareAsync())) {
        // No biometric sensor, but a passcode still works as the unlock method.
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        return level === LocalAuthentication.SecurityLevel.NONE ? 'no_hardware' : 'ok';
      }
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      return level === LocalAuthentication.SecurityLevel.NONE ? 'not_enrolled' : 'ok';
    } catch {
      return 'no_hardware';
    }
  }

  async authenticate(prompt: { title: string; cancel: string }): Promise<boolean> {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt.title,
      cancelLabel: prompt.cancel,
      disableDeviceFallback: false,
    });
    return result.success;
  }
}

export async function loadLockSettings(): Promise<LockSettings> {
  const raw = await readPref('lock');
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<LockSettings>;
    const timeoutSec = (TIMEOUT_CHOICES as readonly number[]).includes(parsed.timeoutSec ?? -1) ? (parsed.timeoutSec as number) : 0;
    return { enabled: parsed.enabled === true, timeoutSec };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveLockSettings(settings: LockSettings): Promise<void> {
  await writePref('lock', JSON.stringify(settings));
}
