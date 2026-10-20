import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { json, makeHarness, type Handler } from '../../test/helpers';
import { TeraBoxDeviceScreen, isSafeQrDataUrl } from './TeraBoxDeviceScreen';
import { TeraBoxLoginScreen, validateTeraBoxLogin } from './TeraBoxLoginScreen';

jest.mock('../../transfers/device', () => ({
  DeviceFileSource: class {},
  chunkFetch: jest.fn(),
  clearDownloadCache: jest.fn(),
  createDownloader: jest.fn(),
  prefsTransferPersistence: { load: async () => [], save: async () => undefined },
}));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const Stack = createNativeStackNavigator();

async function renderScreen(handler: Handler, element: 'device' | 'login') {
  const h = makeHarness(handler, { signedIn: true });
  await h.services.session.restore();
  await render(
    h.wrap(
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Home" options={{ headerShown: false }}>
            {() => (element === 'device' ? <TeraBoxDeviceScreen minPollMs={10} /> : <TeraBoxLoginScreen />)}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>,
    ),
  );
  return h;
}

describe('isSafeQrDataUrl', () => {
  it('accepts only a base64 PNG data URL of sane size', () => {
    expect(isSafeQrDataUrl(PNG)).toBe(true);
    expect(isSafeQrDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isSafeQrDataUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeQrDataUrl('https://evil.example.com/qr.png')).toBe(false);
    expect(isSafeQrDataUrl(`data:image/png;base64,${'A'.repeat(500_000)}`)).toBe(false);
  });
});

describe('TeraBoxDeviceScreen (official device-code flow)', () => {
  it('shows the QR from the server, polls until approved and refreshes the account list', async () => {
    let polls = 0;
    const h = await renderScreen(({ path, method }) => {
      if (path === '/providers/terabox_open/device/start' && method === 'POST')
        return json({ handle: 'h'.repeat(40), qrCodeDataUrl: PNG, expiresInSeconds: 300, intervalSeconds: 1 });
      if (path === '/providers/terabox_open/device/poll') {
        polls += 1;
        return json(polls < 3 ? { status: 'pending', retryAfterSeconds: 1 } : { status: 'connected', accountId: 'a1' });
      }
      return json({ code: 'NOT_FOUND', message: 'x' }, 404);
    }, 'device');
    expect(await screen.findByLabelText('TeraBox authorization QR code')).toBeTruthy();
    expect(screen.getByText(/Waiting for approval/)).toBeTruthy();
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(3), { timeout: 8000 });
    const poll = h.calls.find((c) => c.path === '/providers/terabox_open/device/poll');
    expect(poll?.body).toEqual({ handle: 'h'.repeat(40) });
  }, 20000);

  it('refuses a QR that is not a PNG data URL', async () => {
    await renderScreen(({ path }) => {
      if (path === '/providers/terabox_open/device/start')
        return json({ handle: 'h'.repeat(40), qrCodeDataUrl: 'javascript:alert(1)', expiresInSeconds: 300, intervalSeconds: 1 });
      return json({ code: 'NOT_FOUND', message: 'x' }, 404);
    }, 'device');
    expect(await screen.findByText(/unexpected answer/)).toBeTruthy();
    expect(screen.queryByLabelText('TeraBox authorization QR code')).toBeNull();
  });

  it('offers a fresh start when the server says the authorization expired', async () => {
    let starts = 0;
    await renderScreen(({ path }) => {
      if (path === '/providers/terabox_open/device/start') {
        starts += 1;
        return json({ handle: 'h'.repeat(40), qrCodeDataUrl: PNG, expiresInSeconds: 300, intervalSeconds: 1 });
      }
      if (path === '/providers/terabox_open/device/poll') return json({ code: 'DEVICE_FLOW_NOT_FOUND', message: 'gone' }, 404);
      return json({ code: 'NOT_FOUND', message: 'x' }, 404);
    }, 'device');
    expect(await screen.findByText('The QR code expired. Start again to get a new one.', undefined, { timeout: 6000 })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(starts).toBe(2));
  }, 20000);

  it('explains plainly when the server has no TeraBox application configured', async () => {
    await renderScreen(
      ({ path }) =>
        path === '/providers/terabox_open/device/start'
          ? json({ code: 'PROVIDER_NOT_AVAILABLE', message: 'x' }, 409)
          : json({ code: 'NOT_FOUND', message: 'x' }, 404),
      'device',
    );
    expect(await screen.findByText(/HTTP 409 · PROVIDER_NOT_AVAILABLE/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('TeraBoxLoginScreen (experimental)', () => {
  it('validates before sending anything', () => {
    expect(validateTeraBoxLogin({ name: '', email: '', password: '', cookie: '' })).toBe('credentialsRequired');
    expect(validateTeraBoxLogin({ name: '', email: 'not-an-email', password: 'x', cookie: '' })).toBe('emailInvalid');
    expect(validateTeraBoxLogin({ name: '', email: 'a@b.co', password: 'x', cookie: '' })).toBeNull();
    expect(validateTeraBoxLogin({ name: '', email: '', password: '', cookie: 'BDUSS=abc' })).toBeNull();
  });

  it('warns that the connection is experimental and sends the credentials once to the server', async () => {
    const h = await renderScreen(({ path, method }) => {
      if (path === '/providers/terabox/accounts' && method === 'POST') return json({ account: { id: 'a1', status: 'connected' } }, 201);
      return json({ code: 'NOT_FOUND', message: 'x' }, 404);
    }, 'login');
    expect(await screen.findByText('Experimental connection')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'me@example.com');
    const password = screen.getByLabelText('Password');
    expect(password.props.secureTextEntry).toBe(true);
    await fireEvent.changeText(password, 'p4ssw0rd!');
    await fireEvent.press(screen.getByRole('button', { name: 'Connect TeraBox' }));
    await waitFor(() => expect(h.calls.some((c) => c.path === '/providers/terabox/accounts')).toBe(true));
    expect(h.calls.find((c) => c.path === '/providers/terabox/accounts')?.body).toEqual({ email: 'me@example.com', password: 'p4ssw0rd!' });
    expect(h.store.value && JSON.stringify(h.store.value)).not.toContain('p4ssw0rd!');
  });

  it('does not pretend success when TeraBox rejects the credentials', async () => {
    await renderScreen(({ path }) => {
      if (path === '/providers/terabox/accounts') return json({ account: { id: 'a1', status: 'unauthorized' } }, 201);
      return json({ code: 'NOT_FOUND', message: 'x' }, 404);
    }, 'login');
    await fireEvent.changeText(await screen.findByLabelText('Email'), 'me@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByRole('button', { name: 'Connect TeraBox' }));
    expect(await screen.findByText(/TeraBox rejected these credentials/)).toBeTruthy();
  });
});
