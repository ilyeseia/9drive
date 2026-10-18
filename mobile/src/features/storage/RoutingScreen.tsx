import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ROUTING_MODES, type RoutingMode } from '../../api/endpoints/providers';
import { useI18n } from '../../i18n/I18nProvider';
import { formatBytes, isolate } from '../../i18n/format';
import { spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card, Screen, StateView, TextField } from '../../ui/components';
import { Chip } from '../../ui/extra';
import { MODE_HELP, MODE_LABEL, isKnownMode, megabytesToBytes, moveId, orderByPriority, providerLabel } from './model';
import { useAccounts, useCatalog, useRoutingPolicy, useStorageActions } from './queries';

/**
 * Shows and edits the user's upload routing policy and previews a placement. The server decides; nothing here
 * reimplements placement rules. If the server refuses a change (permissions), its refusal is shown.
 */
export function RoutingScreen() {
  const { t, describeError, locale } = useI18n();
  const { colors } = useTheme();
  const policy = useRoutingPolicy();
  const accounts = useAccounts();
  const catalog = useCatalog();
  const actions = useStorageActions();
  const [sizeMb, setSizeMb] = useState('');
  const [fileType, setFileType] = useState('');
  const [sizeError, setSizeError] = useState(false);
  const [saved, setSaved] = useState(false);

  if (policy.isPending)
    return (
      <Screen>
        <StateView kind="loading" title={t('loading')} />
      </Screen>
    );
  if (policy.isError || !policy.data)
    return (
      <Screen>
        <StateView kind="error" title={describeError(policy.error)} onRetry={() => void policy.refetch()} />
      </Screen>
    );

  const current = policy.data;
  const known = isKnownMode(current.mode);
  const accountList = accounts.data ?? [];
  const ordered = orderByPriority(accountList, current.priorityAccountIds);
  const priorityIds = ordered.map((a) => a.id);
  const preview = actions.preview.data;

  function save(patch: { mode?: RoutingMode; priorityAccountIds?: string[] }) {
    setSaved(false);
    actions.updatePolicy.mutate(patch, { onSuccess: () => setSaved(true) });
  }

  function runPreview() {
    const bytes = megabytesToBytes(sizeMb);
    setSizeError(bytes === null);
    if (bytes !== null) actions.preview.mutate({ bytes, fileType: fileType.trim() || undefined });
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
        <AppText muted>{t('routingIntro')}</AppText>

        <Card style={{ gap: spacing.md }}>
          <AppText variant="heading" accessibilityRole="header">
            {t('routingMode')}
          </AppText>
          {!known ? <AppText muted>{t('modeUnknown', { mode: current.mode })}</AppText> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {ROUTING_MODES.map((mode) => (
              <Chip
                key={mode}
                label={t(MODE_LABEL[mode])}
                selected={current.mode === mode}
                onPress={() => current.mode !== mode && save({ mode })}
              />
            ))}
          </View>
          {known ? (
            <AppText variant="caption" muted>
              {t(MODE_HELP[current.mode as RoutingMode])}
            </AppText>
          ) : null}
          {actions.updatePolicy.isError ? (
            <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
              {describeError(actions.updatePolicy.error)}
            </AppText>
          ) : null}
          {saved && !actions.updatePolicy.isPending ? (
            <AppText accessibilityRole="alert" style={{ color: colors.success }}>
              {t('routingSaved')}
            </AppText>
          ) : null}
        </Card>

        {current.mode === 'priority' ? (
          <Card style={{ gap: spacing.sm }}>
            <AppText variant="heading" accessibilityRole="header">
              {t('priorityOrder')}
            </AppText>
            {ordered.map((account, index) => (
              <View key={account.id} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <AppText style={{ flex: 1 }} numberOfLines={1}>
                  {`${index + 1}. ${isolate(account.displayName?.trim() || account.email)} · ${providerLabel(account.provider, catalog.data)}`}
                </AppText>
                <Button
                  label={t('moveUp')}
                  variant="secondary"
                  disabled={index === 0 || actions.updatePolicy.isPending}
                  onPress={() => save({ priorityAccountIds: moveId(priorityIds, account.id, -1) })}
                />
                <Button
                  label={t('moveDown')}
                  variant="secondary"
                  disabled={index === ordered.length - 1 || actions.updatePolicy.isPending}
                  onPress={() => save({ priorityAccountIds: moveId(priorityIds, account.id, 1) })}
                />
              </View>
            ))}
          </Card>
        ) : null}

        {current.fileTypeRules.length > 0 || current.minFileSizeBytes || current.maxFileSizeBytes ? (
          <Card style={{ gap: spacing.xs }}>
            {current.fileTypeRules.map((rule) => (
              <AppText key={`${rule.match}-${rule.preferProvider ?? ''}`} variant="caption">
                {`${isolate(rule.match)} → ${providerLabel(rule.preferProvider ?? '—', catalog.data)}`}
              </AppText>
            ))}
            {current.minFileSizeBytes ? (
              <AppText variant="caption">{`≥ ${formatBytes(Number(current.minFileSizeBytes), locale)}`}</AppText>
            ) : null}
            {current.maxFileSizeBytes ? (
              <AppText variant="caption">{`≤ ${formatBytes(Number(current.maxFileSizeBytes), locale)}`}</AppText>
            ) : null}
            <AppText variant="caption" muted>
              {t('fileRulesReadOnly')}
            </AppText>
          </Card>
        ) : null}

        <Card style={{ gap: spacing.md }}>
          <AppText variant="heading" accessibilityRole="header">
            {t('routingPreview')}
          </AppText>
          <AppText variant="caption" muted>
            {t('routingPreviewHelp')}
          </AppText>
          <TextField
            label={t('previewSizeMb')}
            value={sizeMb}
            onChangeText={setSizeMb}
            keyboardType="decimal-pad"
            error={sizeError ? t('previewInvalidSize') : null}
          />
          <TextField label={t('previewType')} value={fileType} onChangeText={setFileType} autoCapitalize="none" autoCorrect={false} />
          <Button label={t('previewRun')} onPress={runPreview} busy={actions.preview.isPending} />
          {actions.preview.isError ? (
            <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
              {describeError(actions.preview.error)}
            </AppText>
          ) : null}
          {preview ? (
            <View style={{ gap: spacing.xs }}>
              <AppText style={{ fontWeight: '700' }}>
                {preview.account
                  ? `${t('previewChosen')}: ${isolate(preview.account.displayName?.trim() || preview.account.email)} · ${providerLabel(preview.account.provider, catalog.data)}`
                  : t('previewNone')}
              </AppText>
              <AppText variant="caption" muted>
                {preview.reason}
              </AppText>
              <AppText variant="label">{t('previewSteps')}</AppText>
              {preview.steps.map((step, index) => (
                <AppText key={`${step.step}-${index}`} variant="caption" muted>
                  {`${index + 1}. ${step.step}: ${step.detail} (${step.candidates} → ${step.candidates - step.eliminated})`}
                </AppText>
              ))}
            </View>
          ) : null}
        </Card>
      </ScrollView>
    </Screen>
  );
}
