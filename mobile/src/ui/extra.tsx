/** Additional design-system pieces: progress bar, filter chip, bottom sheet, text prompt. */

import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { MIN_TARGET, radius, spacing, useTheme } from '../theme/theme';
import { AppText, Button, TextField } from './components';

export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const { colors } = useTheme();
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{ height: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' }}
    >
      <View style={{ height: 6, width: `${pct}%`, backgroundColor: colors.primary }} />
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={{
        minHeight: 40,
        paddingHorizontal: spacing.md,
        borderRadius: radius.pill,
        justifyContent: 'center',
        backgroundColor: selected ? colors.primary : colors.surfaceAlt,
      }}
    >
      <AppText variant="label" style={{ color: selected ? colors.onPrimary : colors.text }}>
        {label}
      </AppText>
    </Pressable>
  );
}

/** Bottom sheet that closes on back/outside press. */
export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} accessibilityViewIsModal>
      <Pressable
        accessibilityLabel={t('close')}
        accessibilityRole="button"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }}
      />
      <View
        style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          padding: spacing.lg,
          maxHeight: '80%',
        }}
      >
        {title ? (
          <AppText variant="heading" accessibilityRole="header" style={{ marginBottom: spacing.md }}>
            {title}
          </AppText>
        ) : null}
        <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

export interface SheetAction {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export function ActionSheet({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean;
  title?: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <View style={{ gap: spacing.xs }}>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ disabled: !!action.disabled }}
            disabled={action.disabled}
            onPress={() => {
              onClose();
              action.onPress();
            }}
            style={{ minHeight: MIN_TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm, opacity: action.disabled ? 0.5 : 1 }}
          >
            <AppText style={{ color: action.destructive ? colors.danger : colors.text, fontWeight: '600' }}>{action.label}</AppText>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

/** Cross-platform single-field text prompt (Alert.prompt is iOS-only). */
export function PromptModal({
  visible,
  title,
  label,
  initialValue = '',
  confirmLabel,
  onSubmit,
  onClose,
  busy,
  error,
}: {
  visible: boolean;
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <View style={{ gap: spacing.md }}>
        <TextField
          label={label}
          value={value}
          onChangeText={setValue}
          autoFocus
          maxLength={255}
          returnKeyType="done"
          onSubmitEditing={() => trimmed && onSubmit(trimmed)}
          error={error ?? null}
        />
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button label={t('cancel')} variant="secondary" onPress={onClose} style={{ flex: 1 }} />
          <Button label={confirmLabel} onPress={() => onSubmit(trimmed)} disabled={trimmed === ''} busy={busy} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}
