import { Linking } from 'react-native';
import { ExternalUrlError, openProviderSignIn, validateExternalUrl } from './externalLink';

describe('validateExternalUrl', () => {
  it('accepts an ordinary https sign-in address', () => {
    expect(validateExternalUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y').hostname).toBe('accounts.google.com');
  });

  it.each([
    ['http://accounts.example.com/auth', 'HTTPS'],
    ['javascript:alert(1)', 'HTTPS'],
    ['intent://scan/#Intent;scheme=zxing;end', 'HTTPS'],
    ['ninedrive://storage', 'HTTPS'],
    ['https://user:pass@accounts.example.com/', 'credentials'],
    ['https://127.0.0.1/auth', 'public'],
    ['https://192.168.1.5/auth', 'public'],
    ['https://localhost/auth', 'public'],
    ['https://[::1]/auth', 'public'],
    ['not a url', 'valid'],
    [`https://example.com/${'a'.repeat(3000)}`, 'long'],
  ])('rejects %s', (raw, reason) => {
    expect(() => validateExternalUrl(raw)).toThrow(ExternalUrlError);
    expect(() => validateExternalUrl(raw)).toThrow(new RegExp(reason));
  });
});

describe('openProviderSignIn', () => {
  // Under jest-expo `Linking.openURL` is already a mock whose call history survives restoreAllMocks.
  beforeEach(() => (Linking.openURL as jest.Mock).mockClear());
  afterEach(() => jest.restoreAllMocks());

  it('opens a valid address in the system browser', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await openProviderSignIn('https://login.example.com/auth?state=1');
    expect(open).toHaveBeenCalledWith('https://login.example.com/auth?state=1');
  });

  it('never opens an invalid address', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await expect(openProviderSignIn('http://evil.example.com')).rejects.toThrow(ExternalUrlError);
    expect(open).not.toHaveBeenCalled();
  });
});
