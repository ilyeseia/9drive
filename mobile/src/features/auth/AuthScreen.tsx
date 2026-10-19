import { useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { ApiError } from '../../api/errors';
import { useServices } from '../../app/services';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/messages';
import { MIN_TARGET, spacing, useTheme } from '../../theme/theme';
import { AppText, BrandMark, Button, Card, Screen, TextField } from '../../ui/components';
import { Icon } from '../../ui/Icon';
import type { SessionLoss } from '../../auth/session';
import { authErrorKey, validateEmail, validateExistingPassword, validateName, validateNewPassword } from './validation';

type Mode = 'signIn' | 'register';

const BANNER: Record<SessionLoss, MessageKey> = {
  expired: 'bannerSessionEnded',
  compromised: 'bannerSessionCompromised',
  disabled: 'errDisabled',
};

export function AuthScreen({ reason }: { reason: SessionLoss | null }) {
  const { t, describeError } = useI18n();
  const { colors } = useTheme();
  const { session } = useServices();
  const [mode, setMode] = useState<Mode>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ name?: MessageKey | null; email?: MessageKey | null; password?: MessageKey | null }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordRef = useRef<ComponentRef<typeof TextInput>>(null);
  const register = mode === 'register';

  async function submit() {
    if (busy) return;
    const next = {
      name: register ? validateName(name) : null,
      email: validateEmail(email),
      password: register ? validateNewPassword(password) : validateExistingPassword(password),
    };
    setErrors(next);
    setFormError(null);
    if (next.name || next.email || next.password) return;
    setBusy(true);
    try {
      if (register) await session.register(name, email, password);
      else await session.signIn(email, password);
      // On success the session store flips to signed-in and this screen unmounts.
    } catch (error) {
      const specific = ApiError.is(error) ? authErrorKey(error.code) : null;
      setFormError(specific ? t(specific) : describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ alignItems: 'center', marginBottom: spacing.sm }}>
            <BrandMark size={72} stacked />
          </View>

          {reason ? (
            <Card style={{ borderColor: colors.warning }}>
              <AppText accessibilityRole="alert" style={{ color: colors.warning }}>
                {t(BANNER[reason])}
              </AppText>
            </Card>
          ) : null}

          <Card style={{ gap: spacing.lg, padding: spacing.xl }}>
            <View style={{ gap: spacing.xs }}>
              <AppText variant="title" accessibilityRole="header">
                {t(register ? 'registerTitle' : 'signInTitle')}
              </AppText>
              <AppText muted>{t(register ? 'registerSubtitle' : 'signInSubtitle')}</AppText>
            </View>

            <View style={{ gap: spacing.md }}>
              {register ? (
                <TextField
                  label={t('fieldName')}
                  icon="user"
                  value={name}
                  onChangeText={setName}
                  error={errors.name ? t(errors.name) : null}
                  autoComplete="name"
                  textContentType="name"
                  returnKeyType="next"
                  onSubmitEditing={() => emailRef.current?.focus()}
                  editable={!busy}
                />
              ) : null}
              <TextField
                inputRef={emailRef}
                label={t('fieldEmail')}
                icon="mail"
                value={email}
                onChangeText={setEmail}
                error={errors.email ? t(errors.email) : null}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                editable={!busy}
              />
              <TextField
                inputRef={passwordRef}
                label={t('fieldPassword')}
                icon="lock"
                value={password}
                onChangeText={setPassword}
                error={errors.password ? t(errors.password) : null}
                secure
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete={register ? 'new-password' : 'current-password'}
                textContentType={register ? 'newPassword' : 'password'}
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
                editable={!busy}
              />
            </View>

            {formError ? (
              <View
                accessibilityRole="alert"
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: spacing.sm,
                  padding: spacing.md,
                  borderRadius: 12,
                  backgroundColor: `${colors.danger}1F`,
                  borderWidth: 1,
                  borderColor: `${colors.danger}66`,
                }}
              >
                <Icon name="alert" size={18} color={colors.danger} />
                <AppText variant="caption" style={{ color: colors.danger, flex: 1 }}>
                  {formError}
                </AppText>
              </View>
            ) : null}

            <Button label={t(register ? 'register' : 'signIn')} onPress={() => void submit()} busy={busy} />
          </Card>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setMode(register ? 'signIn' : 'register');
              setErrors({});
              setFormError(null);
            }}
            disabled={busy}
            style={{ minHeight: MIN_TARGET, alignItems: 'center', justifyContent: 'center' }}
          >
            <AppText style={{ color: colors.primary, fontWeight: '600' }}>{t(register ? 'switchToSignIn' : 'switchToRegister')}</AppText>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
