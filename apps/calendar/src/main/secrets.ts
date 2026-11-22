/**
 * Tokens, sealed with Electron's `safeStorage` (the system keyring: GNOME Keyring or KWallet
 * on Linux, DPAPI on Windows). If the system has no usable keyring, the token is kept as is
 * and the app says so in Settings (the same rule as the Workspace desktop app's Google
 * connection).
 */
import { safeStorage } from 'electron';

interface Sealed {
  enc: 'os' | 'plain';
  value: string;
}

/** Whether tokens are encrypted by the system's keyring. */
export function secureStorage(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
  return backend !== 'basic_text' && backend !== 'unknown';
}

export function seal(token: string): string {
  const sealed: Sealed = secureStorage()
    ? { enc: 'os', value: safeStorage.encryptString(token).toString('base64') }
    : { enc: 'plain', value: token };
  return JSON.stringify(sealed);
}

/** The token, or null if it can't be read (a keyring that changed). */
export function unseal(stored: string): string | null {
  try {
    const sealed = JSON.parse(stored) as Sealed;
    if (sealed.enc === 'plain') return sealed.value;
    return safeStorage.decryptString(Buffer.from(sealed.value, 'base64'));
  } catch {
    return null;
  }
}
