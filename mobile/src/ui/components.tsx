/**
 * Design-system primitives. Every interactive element has an accessibility role and label, a touch target of
 * at least 48dp, a visible disabled/busy state, and uses logical (start/end) spacing so it mirrors in RTL.
 */

import { useState, type ComponentProps, type ComponentRef, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MIN_TARGET, radius, spacing, useTheme } from '../theme/theme';
import { useI18n } from '../i18n/I18nProvider';

type Variant = 'title' | 'heading' | 'body' | 'caption' | 'label';

const TEXT: Record<Variant, TextStyle> = {
  title: { fontSize: 26, fontWeight: '800', lineHeight: 32 },
  heading: { fontSize: 18, fontWeight: '700', lineHeight: 24 },
  body: { fontSize: 16, fontWeight: '400', lineHeight: 22 },
  caption: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  label: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
};

export function AppText({
  variant = 'body',
  muted,
  style,
  ...props
}: ComponentProps<typeof Text> & { variant?: Variant; muted?: boolean }) {
  const { colors } = useTheme();
  // Dynamic type is honoured; the multiplier cap only prevents layouts from breaking at extreme sizes.
  return <Text maxFontSizeMultiplier={1.6} {...props} style={[TEXT[variant], { color: muted ? colors.textMuted : colors.text }, style]} />;
}

export function Screen({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView
      style={[{ flex: 1, backgroundColor: colors.background }, padded && { padding: spacing.lg }, style]}
      edges={['top', 'left', 'right']}
    >
      {children}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.lg,
          padding: spacing.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({ label, onPress, variant = 'primary', busy, disabled, accessibilityHint, style }: ButtonProps) {
  const { colors } = useTheme();
  const inactive = disabled || busy;
  const background = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : colors.surfaceAlt;
  const foreground = variant === 'primary' ? colors.onPrimary : variant === 'danger' ? colors.onDanger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: MIN_TARGET,
          paddingHorizontal: spacing.lg,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: spacing.sm,
          backgroundColor: background,
          opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={foreground} /> : null}
      <Text maxFontSizeMultiplier={1.6} style={{ color: foreground, fontSize: 16, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}

export interface TextFieldProps extends Omit<ComponentProps<typeof TextInput>, 'style' | 'ref'> {
  label: string;
  error?: string | null;
  secure?: boolean;
  inputRef?: Ref<ComponentRef<typeof TextInput>>;
}

export function TextField({ label, error, secure, inputRef, ...props }: TextFieldProps) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const [hidden, setHidden] = useState(!!secure);
  return (
    <View style={{ gap: spacing.xs }}>
      <AppText variant="label">{label}</AppText>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: error ? colors.danger : colors.border,
          borderRadius: radius.md,
          backgroundColor: colors.surface,
        }}
      >
        <TextInput
          ref={inputRef}
          accessibilityLabel={label}
          placeholderTextColor={colors.textMuted}
          maxFontSizeMultiplier={1.6}
          {...props}
          secureTextEntry={secure ? hidden : props.secureTextEntry}
          style={{ flex: 1, minHeight: MIN_TARGET, paddingHorizontal: spacing.md, color: colors.text, fontSize: 16 }}
        />
        {secure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hidden ? t('showPassword') : t('hidePassword')}
            onPress={() => setHidden((v) => !v)}
            style={{ minHeight: MIN_TARGET, minWidth: MIN_TARGET, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '600' }}>
              {hidden ? t('showPassword') : t('hidePassword')}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <AppText variant="caption" accessibilityRole="alert" style={{ color: colors.danger }}>
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

/** Loading / empty / error block with an optional retry. Used by every list screen for consistent states. */
export function StateView({
  kind,
  title,
  message,
  onRetry,
}: {
  kind: 'loading' | 'empty' | 'error';
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md }}
      accessibilityLiveRegion="polite"
    >
      {kind === 'loading' ? <ActivityIndicator accessibilityLabel={t('loading')} color={colors.primary} /> : null}
      {title ? (
        <AppText variant="heading" style={{ textAlign: 'center' }} accessibilityRole={kind === 'error' ? 'alert' : undefined}>
          {title}
        </AppText>
      ) : null}
      {message ? (
        <AppText muted style={{ textAlign: 'center' }}>
          {message}
        </AppText>
      ) : null}
      {onRetry ? <Button label={t('retry')} variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }, style]}>{children}</View>;
}
