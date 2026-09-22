import React, { createContext, useContext, type ReactNode } from "react";
import {
  StyleSheet,
  Text as ReactNativeText,
  View,
  type ColorSchemeName,
  type KeyboardTypeOptions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
  useColorScheme,
} from "react-native";
import {
  BottomSheet as ExpoBottomSheet,
  Button as ExpoButton,
  Column as ExpoColumn,
  Host as ExpoHost,
  Row as ExpoRow,
  Spacer as ExpoSpacer,
  Switch as ExpoSwitch,
  Text as ExpoText,
  TextInput as ExpoTextInput,
} from "@expo/ui";
import {
  colors,
  getTheme,
  radii,
  spacing,
  typography,
  type OpenMuseTheme,
  type ThemeMode,
} from "@openmuse/design-tokens";

type ThemeContextValue = OpenMuseTheme;

const ThemeContext = createContext<ThemeContextValue>(getTheme("light"));

export function NativeThemeProvider({ children, mode }: { children: ReactNode; mode?: ThemeMode }) {
  const systemScheme = useColorScheme();
  const resolvedMode = mode ?? (systemScheme === "dark" ? "dark" : "light");
  return <ThemeContext.Provider value={getTheme(resolvedMode)}>{children}</ThemeContext.Provider>;
}

export function useNativeTheme() {
  return useContext(ThemeContext);
}

export function NativeHost({
  children,
  style,
  colorScheme,
  matchContents,
}: {
  children: ReactNode;
  style?: unknown;
  colorScheme?: ColorSchemeName;
  matchContents?: boolean | { horizontal?: boolean; vertical?: boolean };
}) {
  return (
    <ExpoHost colorScheme={colorScheme} matchContents={matchContents} style={style as never}>
      {children}
    </ExpoHost>
  );
}

type TextVariant = keyof typeof typography;

const textColors: Record<TextVariant, keyof OpenMuseTheme> = {
  display: "ink",
  title: "ink",
  heading: "ink",
  body: "ink",
  bodyStrong: "ink",
  caption: "mutedInk",
  micro: "quietInk",
};

export function NativeText({
  children,
  variant = "body",
  color,
  style,
  numberOfLines,
  onPress,
  testID,
}: {
  children: ReactNode;
  variant?: TextVariant;
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  onPress?: () => void;
  testID?: string;
}) {
  const theme = useNativeTheme();
  const flattened = StyleSheet.flatten(style) ?? {};
  const textStyle = {
    ...typography[variant],
    color: color ?? theme[textColors[variant]],
    ...flattened,
  };
  const text = typeof children === "string" || typeof children === "number" ? String(children) : "";
  return (
    <ExpoText
      numberOfLines={numberOfLines}
      onPress={onPress}
      testID={testID}
      textStyle={textStyle as never}
    >
      {text}
    </ExpoText>
  );
}

export function NativeButton({
  label,
  onPress,
  variant = "filled",
  disabled,
  style,
  testID,
  children,
}: {
  label?: string;
  onPress?: () => void;
  variant?: "filled" | "outlined" | "text";
  disabled?: boolean;
  style?: unknown;
  testID?: string;
  children?: ReactNode;
}) {
  const theme = useNativeTheme();
  return (
    <ExpoButton
      disabled={disabled}
      label={label}
      onPress={onPress}
      style={StyleSheet.flatten([
        styles.button,
        style as StyleProp<ViewStyle>,
        { borderColor: theme.line },
      ])}
      testID={testID}
      variant={variant}
    >
      {children}
    </ExpoButton>
  );
}

export function NativeField({
  placeholder,
  defaultValue,
  onChangeText,
  onSubmitEditing,
  secureTextEntry,
  multiline,
  numberOfLines,
  autoCapitalize = "sentences",
  keyboardType,
  editable = true,
  testID,
}: {
  placeholder?: string;
  defaultValue?: string;
  onChangeText?: (text: string) => void;
  onSubmitEditing?: (event: unknown) => void;
  secureTextEntry?: boolean;
  multiline?: boolean;
  numberOfLines?: number;
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
  keyboardType?: KeyboardTypeOptions;
  editable?: boolean;
  testID?: string;
}) {
  const theme = useNativeTheme();
  return (
    <ExpoTextInput
      autoCapitalize={autoCapitalize}
      defaultValue={defaultValue}
      editable={editable}
      keyboardType={keyboardType}
      multiline={multiline}
      numberOfLines={numberOfLines}
      onChangeText={onChangeText}
      onSubmitEditing={onSubmitEditing}
      placeholder={placeholder}
      placeholderTextColor={theme.quietInk}
      secureTextEntry={secureTextEntry}
      style={StyleSheet.flatten([styles.field, { borderColor: theme.line, color: theme.ink }])}
      testID={testID}
    />
  );
}

export function NativeColumn({
  children,
  spacing: gap = spacing.md,
  style,
  alignment,
}: {
  children: ReactNode;
  spacing?: number;
  style?: unknown;
  alignment?: "start" | "center" | "end";
}) {
  return (
    <ExpoColumn alignment={alignment} spacing={gap} style={style as never}>
      {children}
    </ExpoColumn>
  );
}

export function NativeRow({
  children,
  spacing: gap = spacing.sm,
  style,
  alignment,
}: {
  children: ReactNode;
  spacing?: number;
  style?: unknown;
  alignment?: "start" | "center" | "end";
}) {
  return (
    <ExpoRow alignment={alignment} spacing={gap} style={style as never}>
      {children}
    </ExpoRow>
  );
}

export function NativeSpacer({ flexible = true }: { flexible?: boolean }) {
  return <ExpoSpacer flexible={flexible} />;
}

export function NativeCard({
  children,
  style,
  inset = true,
}: {
  children: ReactNode;
  style?: unknown;
  inset?: boolean;
}) {
  const theme = useNativeTheme();
  return (
    <NativeHost
      matchContents={{ vertical: true }}
      style={StyleSheet.flatten([
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.line },
        inset && { padding: spacing.lg },
        style as StyleProp<ViewStyle>,
      ])}
    >
      <NativeColumn spacing={spacing.sm}>{children}</NativeColumn>
    </NativeHost>
  );
}

export function NativeSheet({
  children,
  isPresented,
  onDismiss,
}: {
  children: ReactNode;
  isPresented: boolean;
  onDismiss: () => void;
}) {
  return (
    <ExpoBottomSheet isPresented={isPresented} onDismiss={onDismiss}>
      <NativeHost style={styles.sheetContent}>
        <NativeColumn spacing={spacing.md}>{children}</NativeColumn>
      </NativeHost>
    </ExpoBottomSheet>
  );
}

export function NativeToggle({
  value,
  onValueChange,
  disabled,
  testID,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <ExpoSwitch disabled={disabled} onValueChange={onValueChange} testID={testID} value={value} />
  );
}

export function NativeDivider() {
  const theme = useNativeTheme();
  return <View style={[styles.divider, { backgroundColor: theme.line }]} />;
}

export function NativeBadge({
  children,
  tone = "accent",
}: {
  children: string;
  tone?: "accent" | "success" | "danger" | "neutral";
}) {
  const theme = useNativeTheme();
  const background =
    tone === "accent"
      ? theme.accentWash
      : tone === "success"
        ? theme.successWash
        : tone === "danger"
          ? theme.dangerWash
          : theme.line;
  const foreground =
    tone === "accent"
      ? theme.accent
      : tone === "success"
        ? theme.success
        : tone === "danger"
          ? theme.danger
          : theme.mutedInk;
  return (
    <View style={[styles.badge, { backgroundColor: background }]}>
      <NativeText color={foreground} variant="micro">
        {children}
      </NativeText>
    </View>
  );
}

export function NativeEmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <NativeHost style={styles.emptyState}>
      <NativeColumn alignment="center" spacing={spacing.sm}>
        <NativeText variant="heading">{title}</NativeText>
        <NativeText color={colors.mutedInk} style={styles.centerText}>
          {detail}
        </NativeText>
        {action}
      </NativeColumn>
    </NativeHost>
  );
}

export function NativeLoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <NativeHost style={styles.emptyState}>
      <NativeColumn alignment="center" spacing={spacing.sm}>
        <View style={styles.loadingDot} />
        <NativeText color={colors.mutedInk}>{label}</NativeText>
      </NativeColumn>
    </NativeHost>
  );
}

export function NativeErrorState({
  title = "Something went wrong",
  detail,
  onRetry,
}: {
  title?: string;
  detail: string;
  onRetry?: () => void;
}) {
  return (
    <NativeHost style={styles.emptyState}>
      <NativeColumn alignment="center" spacing={spacing.sm}>
        <NativeText color={colors.danger} variant="heading">
          {title}
        </NativeText>
        <NativeText color={colors.mutedInk} style={styles.centerText}>
          {detail}
        </NativeText>
        {onRetry ? <NativeButton label="Try again" onPress={onRetry} variant="outlined" /> : null}
      </NativeColumn>
    </NativeHost>
  );
}

export function NativeScreenTitle({
  eyebrow,
  title,
  detail,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
}) {
  return (
    <NativeColumn spacing={spacing.xs}>
      {eyebrow ? (
        <NativeText variant="micro" color={colors.coralDeep}>
          {eyebrow.toUpperCase()}
        </NativeText>
      ) : null}
      <NativeText variant="title">{title}</NativeText>
      {detail ? <NativeText color={colors.mutedInk}>{detail}</NativeText> : null}
    </NativeColumn>
  );
}

export const uiColors = colors;
export { colors, radii, spacing, typography };

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    borderRadius: radii.md,
  },
  field: {
    minHeight: 48,
    width: "100%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    fontSize: typography.body.fontSize,
  },
  card: {
    width: "100%",
    borderWidth: 1,
    borderRadius: radii.lg,
  },
  sheetContent: {
    width: "100%",
    padding: spacing.xl,
  },
  divider: {
    width: "100%",
    height: StyleSheet.hairlineWidth,
  },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
  },
  emptyState: {
    flex: 1,
    width: "100%",
    minHeight: 180,
    padding: spacing.xl,
    justifyContent: "center",
  },
  centerText: {
    textAlign: "center",
  },
  loadingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.coral,
  },
});

export type { ReactNode };
export { ReactNativeText };
