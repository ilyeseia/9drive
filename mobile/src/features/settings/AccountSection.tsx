import { useState } from 'react';
import { Alert, View } from 'react-native';
import { useLockState, useServices, useSession } from '../../app/services';
import { TIMEOUT_CHOICES } from '../../auth/lock';
import { isolate } from '../../i18n/format';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/messages';
import { spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card } from '../../ui/components';

const TIMEOUT_LABEL: Record<(typeof TIMEOUT_CHOICES)[number], MessageKey> = {
  0: 'lockImmediately',
  60: 'lock1m',
  300: 'lock5m',
  900: 'lock15m',
};

export function AccountSection() {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { session, lock } = useServices();
  const state = useSession();
  const lockState = useLockState();
  const [lockMessage, setLockMessage] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const prompt = { title: t('unlockPrompt'), cancel: t('cancel') };

  if (state.status !== 'signedIn') return null;

  function confirmSignOut() {
    Alert.alert(t('signOutConfirmTitle'), t('signOutConfirmBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('signOut'),
        style: 'destructive',
        onPress: () => {
          void session.signOut().then(({ serverRevoked }) => {
            if (!serverRevoked) Alert.alert(t('signOut'), t('signOutNotRevoked'));
          });
        },
      },
    ]);
  }

  async function toggleLock() {
    setBusy(true);
    setLockMessage(null);
    try {
      if (lockState.settings.enabled) {
        if (!(await lock.disable(prompt))) setLockMessage('lockFailed');
      } else {
        const result = await lock.enable(prompt);
        if (result === 'no_hardware') setLockMessage('lockNoHardware');
        else if (result === 'not_enrolled') setLockMessage('lockNotEnrolled');
        else if (result === 'failed') setLockMessage('lockFailed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card style={{ gap: spacing.xs }}>
        <AppText variant="heading">{t('account')}</AppText>
        <AppText>{isolate(state.user.name)}</AppText>
        <AppText muted>{isolate(state.user.email)}</AppText>
        <View style={{ marginTop: spacing.md }}>
          <Button label={t('signOut')} variant="danger" onPress={confirmSignOut} />
        </View>
      </Card>

      <Card style={{ gap: spacing.md }}>
        <AppText variant="heading">{t('lockTitle')}</AppText>
        <AppText muted variant="caption">
          {t('lockDescription')}
        </AppText>
        <Button
          label={t(lockState.settings.enabled ? 'lockDisable' : 'lockEnable')}
          variant="secondary"
          busy={busy}
          onPress={() => void toggleLock()}
        />
        {lockMessage ? (
          <AppText variant="caption" accessibilityRole="alert" style={{ color: colors.warning }}>
            {t(lockMessage)}
          </AppText>
        ) : null}
        {lockState.settings.enabled ? (
          <View style={{ gap: spacing.sm }}>
            <AppText variant="label">{t('lockTimeout')}</AppText>
            {TIMEOUT_CHOICES.map((seconds) => (
              <Button
                key={seconds}
                label={t(TIMEOUT_LABEL[seconds])}
                variant={lockState.settings.timeoutSec === seconds ? 'primary' : 'secondary'}
                onPress={() => void lock.setTimeout(seconds)}
              />
            ))}
          </View>
        ) : null}
      </Card>
    </>
  );
}
