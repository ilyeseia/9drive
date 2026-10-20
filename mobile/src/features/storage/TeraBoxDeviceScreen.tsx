import { StackActions, useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { providersApi } from '../../api/endpoints/providers';
import { ApiError } from '../../api/errors';
import { useServices } from '../../app/services';
import { describeErrorDetail } from '../../core/errorDetail';
import { useI18n } from '../../i18n/I18nProvider';
import { radius, spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card, Screen, StateView } from '../../ui/components';

/** The server sends a PNG data URL; anything else (or something huge) is refused before it reaches an <Image>. */
export function isSafeQrDataUrl(value: string): boolean {
  return /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value) && value.length <= 400_000;
}

type Flow = { handle: string; qr: string; expiresAt: number; intervalSeconds: number };
type Phase = 'starting' | 'waiting' | 'expired' | 'error';

const MAX_TRANSIENT_POLL_FAILURES = 5;

/**
 * Official TeraBox connection (device-code mode). The server keeps the device code and only hands the app an opaque
 * handle plus a QR image; the user approves in the TeraBox app and the server finishes the sign-in. The app never
 * handles a TeraBox token or password.
 */
export function TeraBoxDeviceScreen({ minPollMs = 2000 }: { minPollMs?: number }) {
  const { t, describeError } = useI18n();
  const { colors } = useTheme();
  const { client } = useServices();
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState<{ text: string; detail: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const startId = useRef(0);

  // The request itself only updates state after the awaited call, so it is safe to run from an effect.
  const request = useCallback(async () => {
    const id = ++startId.current;
    try {
      const data = await providersApi.startTeraboxDevice(client);
      if (id !== startId.current) return;
      if (!isSafeQrDataUrl(data.qrCodeDataUrl)) {
        throw new ApiError('invalid_response', 200, null, 'Unexpected QR code.');
      }
      setFlow({
        handle: data.handle,
        qr: data.qrCodeDataUrl,
        expiresAt: Date.now() + data.expiresInSeconds * 1000,
        intervalSeconds: data.intervalSeconds,
      });
      setPhase('waiting');
    } catch (e) {
      if (id !== startId.current) return;
      setError({ text: describeError(e), detail: describeErrorDetail(e) });
      setPhase('error');
    }
  }, [client, describeError]);

  /** Buttons: reset the screen state, then ask the server for a fresh authorization. */
  const start = useCallback(() => {
    setPhase('starting');
    setError(null);
    setFlow(null);
    void request();
  }, [request]);

  useEffect(() => {
    // Deferred one tick so state is only ever set from a callback, never synchronously inside the effect.
    const timer = setTimeout(() => void request(), 0);
    return () => {
      clearTimeout(timer);
      startId.current += 1; // abandon any in-flight start
    };
  }, [request]);

  // Countdown label.
  useEffect(() => {
    if (phase !== 'waiting') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Poll the server (it rate-limits per its own interval and tells us how long to wait).
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > flow.expiresAt) {
        setPhase('expired');
        return;
      }
      let waitMs = Math.max(minPollMs, flow.intervalSeconds * 1000);
      try {
        const result = await providersApi.pollTeraboxDevice(client, flow.handle);
        if (cancelled) return;
        failures = 0;
        if (result.status === 'connected') {
          await queryClient.invalidateQueries({ queryKey: ['storage'] });
          navigation.dispatch(StackActions.popToTop());
          return;
        }
        waitMs = Math.max(minPollMs, (result.retryAfterSeconds ?? flow.intervalSeconds) * 1000);
      } catch (e) {
        if (cancelled) return;
        if (ApiError.is(e) && e.code === 'DEVICE_FLOW_NOT_FOUND') {
          setPhase('expired');
          return;
        }
        failures += 1;
        if (!(ApiError.is(e) && e.transient) || failures >= MAX_TRANSIENT_POLL_FAILURES) {
          setError({ text: describeError(e), detail: describeErrorDetail(e) });
          setPhase('error');
          return;
        }
      }
      timer = setTimeout(() => void tick(), waitMs);
    };
    timer = setTimeout(() => void tick(), Math.max(minPollMs, flow.intervalSeconds * 1000));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [flow, client, queryClient, navigation, minPollMs, describeError]);

  if (phase === 'starting') {
    return (
      <Screen>
        <StateView kind="loading" title={t('teraboxStarting')} />
      </Screen>
    );
  }
  if (phase === 'error') {
    return (
      <Screen>
        <StateView kind="error" title={error?.text ?? t('errUnknown')} message={error?.detail} onRetry={() => void start()} />
      </Screen>
    );
  }
  if (phase === 'expired' || !flow) {
    return (
      <Screen>
        <StateView kind="empty" title={t('teraboxExpired')} action={{ label: t('teraboxStartAgain'), onPress: () => void start() }} />
      </Screen>
    );
  }

  const secondsLeft = Math.max(0, Math.round((flow.expiresAt - now) / 1000));
  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, alignItems: 'stretch' }}>
        <AppText variant="heading" accessibilityRole="header">
          {t('teraboxScanTitle')}
        </AppText>
        <View style={{ alignItems: 'center' }}>
          <View style={{ padding: spacing.md, borderRadius: radius.xl, backgroundColor: '#FFFFFF' }}>
            <Image
              accessibilityRole="image"
              accessibilityLabel={t('teraboxQrLabel')}
              source={{ uri: flow.qr }}
              style={{ width: 240, height: 240 }}
              resizeMode="contain"
            />
          </View>
        </View>
        <AppText accessibilityLiveRegion="polite" style={{ textAlign: 'center', fontWeight: '700' }}>
          {t('teraboxWaiting')} · {t('teraboxExpiresIn', { seconds: secondsLeft })}
        </AppText>
        <Card style={{ gap: spacing.sm }}>
          <AppText>{t('teraboxStep1')}</AppText>
          <AppText>{t('teraboxStep2')}</AppText>
          <AppText>{t('teraboxStep3')}</AppText>
          <AppText variant="caption" style={{ color: colors.textMuted }}>
            {t('teraboxSamePhoneHint')}
          </AppText>
        </Card>
        <Button label={t('teraboxStartAgain')} variant="secondary" onPress={() => void start()} />
      </ScrollView>
    </Screen>
  );
}
