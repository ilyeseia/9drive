import { useState } from 'react';
import { Alert, Share, View } from 'react-native';
import { isTrustedShareUrl } from '../../api/endpoints/sharing';
import { useServices } from '../../app/services';
import { copySensitive } from '../../core/clipboard';
import { formatDate, isolate } from '../../i18n/format';
import { useI18n } from '../../i18n/I18nProvider';
import { spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card } from '../../ui/components';
import { useShareActions, useShares } from './queries';

/**
 * Public share links for one file. Honest about what the backend offers: a link is created with no options, is
 * visible only once, expires on the server's schedule, and revoking removes every link of the file.
 */
export function SharePanel({ fileId, fileName }: { fileId: string; fileName: string }) {
  const { t, describeError, locale } = useI18n();
  const { colors } = useTheme();
  const { client } = useServices();
  const shares = useShares();
  const actions = useShareActions();
  const [link, setLink] = useState<{ url: string; shareId: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);

  const mine = (shares.data ?? []).filter((s) => s.file.id === fileId);
  const shown = link ? mine.find((s) => s.id === link.shareId) : undefined;

  function confirmCreate() {
    Alert.alert(t('shareWarningTitle'), t('shareWarningBody', { name: fileName }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('shareCreate'),
        onPress: () => {
          setMessage(null);
          actions.create.mutate(fileId, {
            onSuccess: (created) => {
              if (!isTrustedShareUrl(created.url, client.baseUrl)) {
                setLink(null);
                setMessage({ text: t('shareInvalidUrl'), tone: 'bad' });
                return;
              }
              setLink(created);
            },
            onError: (error) => setMessage({ text: describeError(error), tone: 'bad' }),
          });
        },
      },
    ]);
  }

  function confirmRevoke() {
    Alert.alert(t('shareRevokeConfirmTitle'), t('shareRevokeConfirmBody', { name: fileName }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('shareRevokeAll'),
        style: 'destructive',
        onPress: () =>
          actions.revokeAll.mutate(fileId, {
            onSuccess: () => {
              setLink(null);
              setMessage({ text: t('shareRevoked'), tone: 'ok' });
            },
            onError: (error) => setMessage({ text: describeError(error), tone: 'bad' }),
          }),
      },
    ]);
  }

  async function copy() {
    if (!link) return;
    const ok = await copySensitive(link.url).catch(() => false);
    setMessage(ok ? { text: t('shareCopied'), tone: 'ok' } : { text: t('actionFailed'), tone: 'bad' });
  }

  return (
    <Card style={{ gap: spacing.sm }}>
      <AppText variant="heading" accessibilityRole="header">
        {t('shareTitle')}
      </AppText>
      {mine.length > 0 && !link ? (
        <AppText variant="caption" muted>
          {t('shareActive', { count: mine.length })}
          {mine[0] ? ` · ${t('shareExpires', { date: formatDate(mine[0].expiresAt, locale) })}` : ''}
        </AppText>
      ) : null}

      {link ? (
        <View style={{ gap: spacing.sm }}>
          <AppText style={{ fontWeight: '700' }}>{t('shareCreated')}</AppText>
          <AppText selectable variant="caption" style={{ color: colors.primary, writingDirection: 'ltr' }}>
            {isolate(link.url)}
          </AppText>
          {shown ? (
            <AppText variant="caption" muted>
              {t('shareExpires', { date: formatDate(shown.expiresAt, locale) })}
            </AppText>
          ) : null}
          <AppText variant="caption" muted>
            {t('shareOnce')}
          </AppText>
          <Button label={t('shareCopy')} onPress={() => void copy()} />
          <Button
            label={t('shareSend')}
            variant="secondary"
            onPress={() => void Share.share({ message: link.url }).catch(() => undefined)}
          />
        </View>
      ) : (
        <Button label={t('shareCreate')} variant="secondary" busy={actions.create.isPending} onPress={confirmCreate} />
      )}

      {mine.length > 0 ? (
        <Button label={t('shareRevokeAll')} variant="danger" busy={actions.revokeAll.isPending} onPress={confirmRevoke} />
      ) : null}

      {message ? (
        <AppText variant="caption" accessibilityRole="alert" style={{ color: message.tone === 'ok' ? colors.success : colors.danger }}>
          {message.text}
        </AppText>
      ) : null}
    </Card>
  );
}
