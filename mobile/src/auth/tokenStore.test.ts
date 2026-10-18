import * as SecureStore from 'expo-secure-store';
import { SecureTokenStore } from './tokenStore';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const secure = SecureStore as jest.Mocked<typeof SecureStore>;
const SESSION = { accessToken: 'A', refreshToken: 'R', user: { id: 'u', name: 'n', email: 'e@x.co' } };

beforeEach(() => jest.clearAllMocks());

describe('SecureTokenStore', () => {
  it('writes to the platform keystore, device-only, and never to anything else', async () => {
    await new SecureTokenStore().save(SESSION);
    expect(secure.setItemAsync).toHaveBeenCalledWith('9drive.session.v1', JSON.stringify(SESSION), {
      keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    });
  });

  it('round-trips a valid session', async () => {
    secure.getItemAsync.mockResolvedValue(JSON.stringify(SESSION));
    await expect(new SecureTokenStore().load()).resolves.toEqual(SESSION);
  });

  it('returns null for nothing stored', async () => {
    secure.getItemAsync.mockResolvedValue(null);
    await expect(new SecureTokenStore().load()).resolves.toBeNull();
    expect(secure.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('wipes and ignores a corrupt or tampered blob', async () => {
    for (const bad of ['not json', '{"accessToken":1}', JSON.stringify({ ...SESSION, refreshToken: '' })]) {
      secure.getItemAsync.mockResolvedValue(bad);
      await expect(new SecureTokenStore().load()).resolves.toBeNull();
    }
    expect(secure.deleteItemAsync).toHaveBeenCalledTimes(3);
  });

  it('treats an unreadable keystore as "no session" instead of crashing', async () => {
    secure.getItemAsync.mockRejectedValue(new Error('keystore locked'));
    await expect(new SecureTokenStore().load()).resolves.toBeNull();
  });

  it('does not throw when clearing fails', async () => {
    secure.deleteItemAsync.mockRejectedValue(new Error('x'));
    await expect(new SecureTokenStore().clear()).resolves.toBeUndefined();
  });
});
