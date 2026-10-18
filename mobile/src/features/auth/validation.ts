import type { MessageKey } from '../../i18n/messages';

/** Mirrors the server rules (backend auth.routes.ts: name min 2, email, password min 8). The server stays authoritative. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(value: string): MessageKey | null {
  return EMAIL.test(value.trim()) ? null : 'errEmailInvalid';
}

export function validateNewPassword(value: string): MessageKey | null {
  return value.length >= 8 ? null : 'errPasswordShort';
}

export function validateExistingPassword(value: string): MessageKey | null {
  return value.length > 0 ? null : 'errPasswordRequired';
}

export function validateName(value: string): MessageKey | null {
  return value.trim().length >= 2 ? null : 'errNameShort';
}

/** Server error codes that deserve a specific message instead of the generic one for their kind. */
export function authErrorKey(code: string | null): MessageKey | null {
  switch (code) {
    case 'AUTH_INVALID_CREDENTIALS':
      return 'errInvalidCredentials';
    case 'AUTH_EMAIL_TAKEN':
      return 'errEmailTaken';
    case 'CAPTCHA_FAILED':
      return 'errCaptchaRequired';
    default:
      return null;
  }
}
