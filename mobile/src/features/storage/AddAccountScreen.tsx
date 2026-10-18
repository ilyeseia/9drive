import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Switch, View } from 'react-native';
import { ApiError } from '../../api/errors';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/messages';
import { spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card, Screen, TextField } from '../../ui/components';
import { isInsecureEndpoint, validateS3 } from './model';
import { useStorageActions } from './queries';

const EMPTY = { name: '', bucket: '', region: '', endpoint: '', accessKeyId: '', secretAccessKey: '' };

/**
 * Connects an S3-compatible bucket. This is the only provider whose connection needs no browser sign-in, so it is
 * the only one the app can complete; the others are explained honestly. The secret key lives in component state
 * only for the time the form is open: it is not persisted, logged, or kept after a successful connect.
 */
export function AddAccountScreen() {
  const { t, describeError } = useI18n();
  const { colors } = useTheme();
  const navigation = useNavigation();
  const actions = useStorageActions();
  const [form, setForm] = useState(EMPTY);
  const [pathStyle, setPathStyle] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof EMPTY, MessageKey>>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const set = (key: keyof typeof EMPTY) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const err = (key: keyof typeof EMPTY) => (errors[key] ? t(errors[key] as MessageKey) : null);

  function submit() {
    const found = validateS3(form);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length > 0) return;
    actions.connectS3.mutate(
      { ...form, endpoint: form.endpoint.trim() || undefined, forcePathStyle: pathStyle },
      {
        onSuccess: () => {
          setForm(EMPTY); // drop the secret from memory
          navigation.goBack();
        },
        onError: (error) =>
          setServerError(ApiError.is(error) && error.code === 'SSRF_BLOCKED' ? t('errEndpointInvalid') : describeError(error)),
      },
    );
  }

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
          <Card>
            <AppText muted>{t('connectOthersWeb')}</AppText>
          </Card>

          <AppText variant="heading" accessibilityRole="header">
            {t('connectS3')}
          </AppText>
          <View style={{ gap: spacing.md }}>
            <TextField label={t('s3Name')} value={form.name} onChangeText={set('name')} error={err('name')} />
            <TextField
              label={t('s3Bucket')}
              value={form.bucket}
              onChangeText={set('bucket')}
              error={err('bucket')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextField
              label={t('s3Region')}
              value={form.region}
              onChangeText={set('region')}
              error={err('region')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextField
              label={t('s3Endpoint')}
              value={form.endpoint}
              onChangeText={set('endpoint')}
              error={err('endpoint')}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            {isInsecureEndpoint(form.endpoint) ? (
              <AppText variant="caption" accessibilityRole="alert" style={{ color: colors.warning }}>
                {t('s3InsecureWarn')}
              </AppText>
            ) : null}
            <TextField
              label={t('s3AccessKey')}
              value={form.accessKeyId}
              onChangeText={set('accessKeyId')}
              error={err('accessKeyId')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextField
              label={t('s3SecretKey')}
              value={form.secretAccessKey}
              onChangeText={set('secretAccessKey')}
              error={err('secretAccessKey')}
              secure
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
            />
            <AppText variant="caption" muted>
              {t('s3SecretNote')}
            </AppText>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <AppText style={{ flex: 1 }}>{t('s3PathStyle')}</AppText>
              <Switch
                accessibilityLabel={t('s3PathStyle')}
                value={pathStyle}
                onValueChange={setPathStyle}
                trackColor={{ true: colors.primary, false: colors.border }}
              />
            </View>
          </View>

          {serverError ? (
            <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
              {serverError}
            </AppText>
          ) : null}
          <Button label={t('s3Connect')} onPress={submit} busy={actions.connectS3.isPending} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
