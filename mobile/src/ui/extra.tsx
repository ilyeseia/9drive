/** Additional design-system pieces: progress bar, filter chip, bottom sheet, text prompt. */

import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from 'react-native';
import { useI18n } from '../i18n/I18nProvider';
import { MIN_TARGET, radius, spacing, useTheme } from '../theme/theme';
import { AppText, Button, TextField } from './components';
import { Icon, type IconName } from './Icon';

export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const { colors } = useTheme();
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={{ height: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' }}
    >
      {/* Colour warns as the space fills up; the percentage is always available to assistive tech too. */}
      <View
        style={{
          height: 8,
          width: `${pct}%`,
          borderRadius: radius.pill,
          backgroundColor: pct >= 95 ? colors.danger : pct >= 80 ? colors.warning : colors.primary,
        }}
      />
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
        paddingHorizontal: spacing.lg,
        borderRadius: radius.pill,
        justifyContent: 'center',
        backgroundColor: selected ? colors.primary : colors.surfaceAlt,
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.border,
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
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
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

export type Tone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

export function toneColor(tone: Tone, c: ReturnType<typeof useTheme>['colors']): string {
  return tone === 'primary'
    ? c.primary
    : tone === 'accent'
      ? c.accent
      : tone === 'success'
        ? c.success
        : tone === 'warning'
          ? c.warning
          : tone === 'danger'
            ? c.danger
            : c.textMuted;
}

/** Rounded tile with a tinted background and an icon: the visual anchor of a row or card header. */
export function IconTile({ icon, tone = 'primary', size = 44 }: { icon: IconName; tone?: Tone; size?: number }) {
  const { colors } = useTheme();
  const color = toneColor(tone, colors);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: `${color}24`,
      }}
    >
      <Icon name={icon} size={size * 0.5} color={color} />
    </View>
  );
}

/** Compact status label: coloured dot + text. Meaning never relies on colour alone because the text states it. */
export function Pill({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const { colors } = useTheme();
  const color = toneColor(tone, colors);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
        borderRadius: radius.pill,
        backgroundColor: `${color}22`,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <AppText variant="caption" style={{ color, fontWeight: '700' }}>
        {label}
      </AppText>
    </View>
  );
}

/** Page header: large title with an optional subtitle and trailing actions. */
export function ScreenHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="title" accessibilityRole="header" style={{ fontSize: 28, lineHeight: 34 }}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText muted variant="caption">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {right}
    </View>
  );
}

/** Card with an icon + heading row, used for grouped settings. */
export function SectionCard({
  icon,
  title,
  tone = 'primary',
  children,
}: {
  icon: IconName;
  title: string;
  tone?: Tone;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.xl,
        padding: spacing.lg,
        gap: spacing.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <IconTile icon={icon} tone={tone} size={40} />
        <AppText variant="heading" accessibilityRole="header" style={{ flex: 1 }}>
          {title}
        </AppText>
      </View>
      {children}
    </View>
  );
}

/** Segmented single-choice control (language, theme, timeouts). Each option is a labelled, selectable button. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={{
              flexGrow: 1,
              minHeight: MIN_TARGET,
              paddingHorizontal: spacing.lg,
              borderRadius: radius.lg,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: spacing.xs,
              backgroundColor: selected ? colors.primary : colors.surfaceAlt,
              borderWidth: 1,
              borderColor: selected ? colors.primary : colors.border,
            }}
          >
            {selected ? <Icon name="check" size={16} color={colors.onPrimary} strokeWidth={2.6} /> : null}
            <AppText variant="label" style={{ color: selected ? colors.onPrimary : colors.text }}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Round icon-only button with a mandatory accessible label (send, stop, add). */
export function IconButton({
  icon,
  label,
  onPress,
  busy,
  disabled,
  tone = 'primary',
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  tone?: 'primary' | 'neutral';
}) {
  const { colors } = useTheme();
  const inactive = disabled || busy;
  const background = tone === 'primary' ? colors.primary : colors.surfaceAlt;
  const foreground = tone === 'primary' ? colors.onPrimary : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 52,
        height: 52,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        opacity: inactive ? 0.5 : 1,
        transform: [{ scale: pressed && !inactive ? 0.95 : 1 }],
      })}
    >
      {busy ? <ActivityIndicator color={foreground} /> : <Icon name={icon} size={22} color={foreground} />}
    </Pressable>
  );
}
