import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { ApiClient } from '../../api/client';
import { ServicesProvider, type Services } from '../../app/services';
import { LockController } from '../../auth/lock';
import { SessionManager } from '../../auth/session';
import { MemoryTokenStore } from '../../auth/tokenStore';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ThemeProvider } from '../../theme/theme';
import { AuthScreen } from './AuthScreen';
import { authErrorKey, validateEmail, validateExistingPassword, validateName, validateNewPassword } from './validation';

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com' };

function harness(respond: (path: string, body: any) => Response | Promise<Response>) {
  const calls: { path: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    return respond(path, body);
  }) as unknown as typeof fetch;
  const client = new ApiClient({ baseUrl: 'https://api.test', fetchImpl, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } });
  const store = new MemoryTokenStore();
  const session = new SessionManager(client, store);
  const lock = new LockController({
    authenticator: { availability: async () => 'ok', authenticate: async () => true },
    load: async () => ({ enabled: false, timeoutSec: 0 }),
    save: async () => undefined,
  });
  const services: Services = { client, session, lock };
  const wrap = (ui: ReactNode) => (
    <ThemeProvider initialMode="light">
      <I18nProvider initialLocale="en">
        <ServicesProvider services={services}>{ui}</ServicesProvider>
      </I18nProvider>
    </ThemeProvider>
  );
  return { calls, session, store, wrap };
}

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('validation', () => {
  it('mirrors the server rules', () => {
    expect(validateEmail('ada@example.com')).toBeNull();
    expect(validateEmail(' ada@example.com ')).toBeNull();
    for (const bad of ['', 'ada', 'ada@', '@example.com', 'a b@example.com', 'ada@example'])
      expect(validateEmail(bad)).toBe('errEmailInvalid');
    expect(validateNewPassword('1234567')).toBe('errPasswordShort');
    expect(validateNewPassword('12345678')).toBeNull();
    expect(validateExistingPassword('')).toBe('errPasswordRequired');
    expect(validateExistingPassword('x')).toBeNull();
    expect(validateName('A')).toBe('errNameShort');
    expect(validateName(' Al ')).toBeNull();
  });

  it('maps specific server codes', () => {
    expect(authErrorKey('AUTH_INVALID_CREDENTIALS')).toBe('errInvalidCredentials');
    expect(authErrorKey('AUTH_EMAIL_TAKEN')).toBe('errEmailTaken');
    expect(authErrorKey('CAPTCHA_FAILED')).toBe('errCaptchaRequired');
    expect(authErrorKey('SOMETHING_ELSE')).toBeNull();
    expect(authErrorKey(null)).toBeNull();
  });
});

describe('AuthScreen', () => {
  it('does not call the server when the form is invalid and shows field errors', async () => {
    const h = harness(() => ok({}));
    await render(h.wrap(<AuthScreen reason={null} />));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'nope');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(h.calls).toHaveLength(0);
  });

  it('signs in with trimmed credentials and stores the session', async () => {
    const h = harness(() => ok({ accessToken: 'A', refreshToken: 'R', user: USER }));
    await render(h.wrap(<AuthScreen reason={null} />));
    await fireEvent.changeText(screen.getByLabelText('Email'), '  ada@example.com ');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'correct horse');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(h.session.getState().status).toBe('signedIn'));
    expect(h.calls[0]).toEqual({ path: '/auth/login', body: { email: 'ada@example.com', password: 'correct horse' } });
    expect(h.store.value?.refreshToken).toBe('R');
  });

  it('shows a specific message for wrong credentials and stays signed out', async () => {
    const h = harness(() => ok({ code: 'AUTH_INVALID_CREDENTIALS', message: 'x' }, 401));
    await render(h.wrap(<AuthScreen reason={null} />));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Incorrect email or password.')).toBeTruthy();
    expect(h.session.getState().status).not.toBe('signedIn');
  });

  it('shows a friendly message for a network failure, never the raw error', async () => {
    const h = harness(() => {
      throw new TypeError('Network request failed: ECONNREFUSED 10.0.0.5:4000');
    });
    await render(h.wrap(<AuthScreen reason={null} />));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'x');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('You appear to be offline, or the server cannot be reached.')).toBeTruthy();
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
  });

  it('switches to registration, validates the name and explains a captcha-protected server honestly', async () => {
    const h = harness(() => ok({ code: 'CAPTCHA_FAILED', message: 'x' }, 400));
    await render(h.wrap(<AuthScreen reason={null} />));
    await fireEvent.press(screen.getByText('No account? Create one'));
    expect(screen.getAllByText('Create account').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Enter your name (at least 2 characters).')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Ada');
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ada@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'longenough');
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/requires a captcha/)).toBeTruthy();
  });

  it('explains why the user was signed out, including a reused-credentials event', async () => {
    const h = harness(() => ok({}));
    await render(h.wrap(<AuthScreen reason="compromised" />));
    expect(screen.getByText(/credentials were used twice/)).toBeTruthy();
  });

  it('hides the password by default and can reveal it', async () => {
    const h = harness(() => ok({}));
    await render(h.wrap(<AuthScreen reason={null} />));
    const field = screen.getByLabelText('Password');
    expect(field.props.secureTextEntry).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(false);
  });
});
