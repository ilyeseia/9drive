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
import { MIN_TARGET, elevation, radius, spacing, useTheme } from '../theme/theme';
import { useI18n } from '../i18n/I18nProvider';
import { Icon, type IconName } from './Icon';

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

/** Soft decorative glow behind a screen. Purely visual: hidden from assistive tech and never intercepts touches. */
export function Backdrop() {
  const { colors } = useTheme();
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <View
        style={{
          position: 'absolute',
          top: -120,
          right: -100,
          width: 320,
          height: 320,
          borderRadius: 160,
          backgroundColor: `${colors.primary}26`,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: 90,
          left: -140,
          width: 240,
          height: 240,
          borderRadius: 120,
          backgroundColor: `${colors.accent}1A`,
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: -140,
          right: -60,
          width: 300,
          height: 300,
          borderRadius: 150,
          backgroundColor: `${colors.primary}1A`,
        }}
      />
    </View>
  );
}

export function Screen({
  children,
  style,
  padded = true,
  decorated = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  decorated?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <SafeAreaView
      style={[{ flex: 1, backgroundColor: colors.background, overflow: 'hidden' }, padded && { padding: spacing.lg }, style]}
      edges={['top', 'left', 'right']}
    >
      {decorated ? <Backdrop /> : null}
      {children}
    </SafeAreaView>
  );
}

/** Product mark: rounded icon tile plus the wordmark. `stacked` centres the wordmark under a larger tile. */
export function BrandMark({ size = 44, stacked }: { size?: number; stacked?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="9Drive"
      style={{ flexDirection: stacked ? 'column' : 'row', alignItems: 'center', gap: stacked ? spacing.md : spacing.sm }}
    >
      <View
        style={[
          {
            width: size,
            height: size,
            borderRadius: size * 0.32,
            backgroundColor: colors.primary,
            alignItems: 'center',
            justifyContent: 'center',
          },
          elevation(2),
        ]}
      >
        <Icon name="cloud" size={size * 0.54} color={colors.onPrimary} strokeWidth={2.2} />
      </View>
      <Text maxFontSizeMultiplier={1.4} style={{ color: colors.text, fontSize: stacked ? 30 : 22, fontWeight: '800', letterSpacing: 0.4 }}>
        9Drive
      </Text>
    </View>
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
          borderRadius: radius.xl,
          padding: spacing.lg,
        },
        elevation(1),
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
  icon?: IconName;
  /** Smaller horizontal padding for toolbars where several buttons share a row (still >= 48dp tall). */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({ label, onPress, variant = 'primary', busy, disabled, accessibilityHint, icon, compact, style }: ButtonProps) {
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
          minHeight: compact ? MIN_TARGET : 52,
          paddingHorizontal: compact ? spacing.md : spacing.xl,
          borderRadius: radius.lg,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: spacing.sm,
          backgroundColor: background,
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: colors.border,
          opacity: inactive ? 0.55 : 1,
          transform: [{ scale: pressed && !inactive ? 0.98 : 1 }],
        },
        variant === 'primary' && !inactive ? elevation(2) : null,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={foreground} /> : icon ? <Icon name={icon} size={18} color={foreground} /> : null}
      <Text maxFontSizeMultiplier={1.6} style={{ color: foreground, fontSize: 16, fontWeight: '700', letterSpacing: 0.2 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export interface TextFieldProps extends Omit<ComponentProps<typeof TextInput>, 'style' | 'ref'> {
  label: string;
  error?: string | null;
  secure?: boolean;
  /** Optional leading icon (decorative). */
  icon?: IconName;
  inputRef?: Ref<ComponentRef<typeof TextInput>>;
}

export function TextField({ label, error, secure, icon, inputRef, onFocus, onBlur, ...props }: TextFieldProps) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const [hidden, setHidden] = useState(!!secure);
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: spacing.xs }}>
      <AppText variant="label">{label}</AppText>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: focused || error ? 2 : 1,
          borderColor: error ? colors.danger : focused ? colors.primary : colors.border,
          borderRadius: radius.lg,
          backgroundColor: colors.surfaceAlt,
          paddingStart: icon ? spacing.md : 0,
        }}
      >
        {icon ? <Icon name={icon} size={18} color={focused ? colors.primary : colors.textMuted} /> : null}
        <TextInput
          ref={inputRef}
          accessibilityLabel={label}
          placeholderTextColor={colors.textMuted}
          maxFontSizeMultiplier={1.6}
          {...props}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
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
            <Icon name={hidden ? 'eye' : 'eyeOff'} size={20} color={colors.textMuted} />
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
  action,
}: {
  kind: 'loading' | 'empty' | 'error';
  title?: string;
  message?: string;
  onRetry?: () => void;
  /** Primary call to action (for example "Add storage" on an empty list). */
  action?: { label: string; onPress: () => void };
}) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md }}
      accessibilityLiveRegion="polite"
    >
      {kind === 'loading' ? <ActivityIndicator accessibilityLabel={t('loading')} color={colors.primary} size="large" /> : null}
      {kind !== 'loading' ? (
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: kind === 'error' ? `${colors.danger}22` : `${colors.primary}22`,
          }}
        >
          <Icon name={kind === 'error' ? 'alert' : 'folder'} size={32} color={kind === 'error' ? colors.danger : colors.primary} />
        </View>
      ) : null}
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
      {action ? <Button label={action.label} icon="plus" onPress={action.onPress} /> : null}
      {onRetry ? <Button label={t('retry')} variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }, style]}>{children}</View>;
}
