import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { humanizeTool, remainingTime, type ConfirmationDto } from '../../api/endpoints/ai';
import { isolate } from '../../i18n/format';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/messages';
import { MIN_TARGET, spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card } from '../../ui/components';

const RISK_KEY: Record<ConfirmationDto['risk'], MessageKey> = { low: 'aiRiskLow', medium: 'aiRiskMedium', high: 'aiRiskHigh' };

/**
 * The approval card. The server — not this card — enforces confirmation: approving sends the argument hash that was
 * shown, so an action that changed in the meantime is rejected. High-risk actions also need an explicit
 * acknowledgement. Everything shown (summary, sample names, warnings) is server-generated and rendered as plain text.
 */
export function ConfirmationCard({
  confirmation,
  busy,
  onApprove,
  onReject,
  now = Date.now,
}: {
  confirmation: ConfirmationDto;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  now?: () => number;
}) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const [tick, setTick] = useState(() => now());
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(timer);
  }, [now]);

  const remaining = remainingTime(confirmation.expiresAt, tick);
  const expired = remaining === null;
  const needsAck = confirmation.risk === 'high';
  const canApprove = !busy && !expired && (!needsAck || acknowledged);
  const sample = confirmation.preview?.sample ?? [];
  const warnings = confirmation.preview?.warnings ?? [];
  const affected = confirmation.preview?.affectedCount;
  const riskColor = confirmation.risk === 'high' ? colors.danger : confirmation.risk === 'medium' ? colors.warning : colors.success;

  return (
    <Card style={{ gap: spacing.sm, borderColor: riskColor, borderWidth: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
        <AppText variant="heading" accessibilityRole="header">
          {t('aiConfirmTitle')}
        </AppText>
        <AppText variant="label" style={{ color: riskColor }}>
          {t(RISK_KEY[confirmation.risk])}
        </AppText>
        <AppText variant="caption" muted>
          {humanizeTool(confirmation.tool)}
        </AppText>
      </View>
      <AppText variant="caption" muted>
        {t('aiConfirmProposal')}
      </AppText>
      <AppText style={{ fontWeight: '600' }}>{confirmation.summary}</AppText>
      {typeof affected === 'number' ? <AppText variant="caption">{t('aiAffected', { n: affected })}</AppText> : null}

      {sample.length > 0 ? (
        <View>
          <AppText variant="label">{t('aiSample')}</AppText>
          {sample.map((entry, index) => (
            // Names come from storage and are untrusted: shown as text, bidi-isolated.
            <AppText key={`${index}-${entry}`} variant="caption" numberOfLines={2}>
              {`• ${isolate(entry)}`}
            </AppText>
          ))}
        </View>
      ) : null}

      {warnings.length > 0 ? (
        <View>
          <AppText variant="label" style={{ color: colors.warning }}>
            {t('aiWarnings')}
          </AppText>
          {warnings.map((entry, index) => (
            <AppText key={`${index}-${entry}`} variant="caption">
              {`• ${entry}`}
            </AppText>
          ))}
        </View>
      ) : null}

      {needsAck && !expired ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acknowledged }}
          accessibilityLabel={t('aiUnderstand')}
          onPress={() => setAcknowledged((v) => !v)}
          style={{ minHeight: MIN_TARGET, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              borderWidth: 2,
              borderColor: colors.text,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: acknowledged ? colors.primary : 'transparent',
            }}
          >
            {acknowledged ? <AppText style={{ color: colors.onPrimary, fontWeight: '800' }}>✓</AppText> : null}
          </View>
          <AppText variant="caption" style={{ flex: 1 }}>
            {t('aiUnderstand')}
          </AppText>
        </Pressable>
      ) : null}

      <AppText
        variant="caption"
        accessibilityRole={expired ? 'alert' : undefined}
        style={{ color: expired ? colors.danger : colors.textMuted }}
      >
        {expired ? t('aiExpired') : t('aiExpires', { time: remaining })}
      </AppText>

      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button label={busy ? t('aiApproving') : t('aiApprove')} onPress={onApprove} disabled={!canApprove} style={{ flex: 1 }} />
        <Button label={t('aiReject')} variant="secondary" onPress={onReject} disabled={busy} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}
