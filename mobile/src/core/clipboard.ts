import * as Clipboard from 'expo-clipboard';

const CLEAR_AFTER_MS = 90_000;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Copies a sensitive string (a share link) and makes a best-effort attempt to remove it again after 90 seconds —
 * but only if the clipboard still holds exactly that string, so the user's later copies are never wiped.
 * The OS does not allow clearing in the background, so this works while the app stays alive; it is a mitigation,
 * not a guarantee, and the UI does not claim otherwise.
 */
export async function copySensitive(text: string): Promise<boolean> {
  const ok = await Clipboard.setStringAsync(text);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void Clipboard.getStringAsync()
      .then((current) => (current === text ? Clipboard.setStringAsync('') : undefined))
      .catch(() => undefined);
  }, CLEAR_AFTER_MS);
  // Do not keep a process alive just to clear a clipboard.
  (timer as { unref?: () => void }).unref?.();
  return ok;
}
