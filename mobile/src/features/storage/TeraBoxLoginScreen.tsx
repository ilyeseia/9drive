import { StackActions, useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useServices } from '../../app/services';
import { providersApi } from '../../api/endpoints/providers';
import { describeErrorDetail } from '../../core/errorDetail';
import { useI18n } from '../../i18n/I18nProvider';
import { spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card, Screen, TextField } from '../../ui/components';
import { Icon } from '../../ui/Icon';

const EMPTY = { name: '', email: '', password: '', cookie: '' };

/** Validation for the experimental TeraBox sign-in: a session cookie, or both an e-mail and a password. */
export function validateTeraBoxLogin(form: typeof EMPTY): 'credentialsRequired' | 'emailInvalid' | null {
  const hasCookie = form.cookie.trim() !== '';
  const hasLogin = form.email.trim() !== '' && form.password !== '';
  if (!hasCookie && !hasLogin) return 'credentialsRequired';
  if (!hasCookie && !/^\S+@\S+\.\S+$/.test(form.email.trim())) return 'emailInvalid';
  return null;
}

/**
 * Experimental, unofficial TeraBox connection (e-mail + password or a pasted session cookie). The credentials travel
 * once over TLS to the server, which keeps them encrypted to renew the session; the app does not store them and
 * clears the form after a successful connection.
 */
export function TeraBoxLoginScreen() {
  const { t, describeError } = useI18n();
  const { colors } = useTheme();
  const { client } = useServices();
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const [form, setForm] = useState(EMPTY);
  const [problem, setProblem] = useState<'credentialsRequired' | 'emailInvalid' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null);
  const set = (key: keyof typeof EMPTY) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    const found = validateTeraBoxLogin(form);
    setProblem(found);
    setError(null);
    if (found) return;
    setBusy(true);
    try {
      const result = await providersApi.connectTerabox(client, {
        name: form.name.trim() || undefined,
        apiKey: form.cookie.trim() || undefined,
        email: form.email.trim() || undefined,
        password: form.password || undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ['storage'] });
      if (result.status === 'unauthorized') {
        // The account row exists but TeraBox refused the credentials: say so instead of pretending it worked.
        setError({ text: t('teraboxRejected'), detail: null });
        return;
      }
      setForm(EMPTY); // drop the password and cookie from memory
      navigation.dispatch(StackActions.popToTop());
    } catch (e) {
      setError({ text: describeError(e), detail: describeErrorDetail(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
          <Card style={{ borderColor: colors.warning, gap: spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Icon name="alert" size={18} color={colors.warning} />
              <AppText variant="label" style={{ color: colors.warning }}>
                {t('teraboxExperimentalTitle')}
              </AppText>
            </View>
            <AppText variant="caption" muted>
              {t('teraboxExperimentalBody')}
            </AppText>
          </Card>

          <View style={{ gap: spacing.md }}>
            <TextField label={t('teraboxName')} value={form.name} onChangeText={set('name')} editable={!busy} />
            <TextField
              label={t('fieldEmail')}
              icon="mail"
              value={form.email}
              onChangeText={set('email')}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              editable={!busy}
              error={problem === 'emailInvalid' ? t('errEmailInvalid') : null}
            />
            <TextField
              label={t('fieldPassword')}
              icon="lock"
              value={form.password}
              onChangeText={set('password')}
              secure
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              editable={!busy}
            />
            <TextField
              label={t('teraboxCookie')}
              value={form.cookie}
              onChangeText={set('cookie')}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              secure
              editable={!busy}
            />
            <AppText variant="caption" muted>
              {t('teraboxCookieHelp')}
            </AppText>
          </View>

          {problem === 'credentialsRequired' ? (
            <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
              {t('teraboxCredentialsRequired')}
            </AppText>
          ) : null}
          {error ? (
            <Card style={{ borderColor: colors.danger, gap: spacing.xs }}>
              <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
                {error.text}
              </AppText>
              {error.detail ? (
                <AppText variant="caption" muted selectable>
                  {error.detail}
                </AppText>
              ) : null}
            </Card>
          ) : null}
          <Button label={t('teraboxConnect')} onPress={() => void submit()} busy={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
