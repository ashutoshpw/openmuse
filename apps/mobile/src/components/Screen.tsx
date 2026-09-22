import React, { type ReactNode } from "react";
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  NativeButton,
  NativeColumn,
  NativeDivider,
  NativeHost,
  NativeRow,
  NativeText,
  colors,
  spacing,
  useNativeTheme,
} from "@openmuse/ui-native";
import { useSession } from "../state";

export function Screen({
  children,
  scroll = true,
  contentStyle,
  testID,
}: {
  children: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useNativeTheme();
  const content = (
    <NativeHost
      style={StyleSheet.flatten([styles.host, { backgroundColor: theme.background }, contentStyle])}
    >
      <NativeColumn spacing={spacing.lg} style={styles.column}>
        {children}
      </NativeColumn>
    </NativeHost>
  );

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} testID={testID}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollContent}>{content}</ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

export function PageHeader({
  eyebrow,
  title,
  detail,
  action,
  onBack,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <NativeColumn spacing={spacing.md}>
      <NativeRow spacing={spacing.sm} alignment="center">
        {onBack ? (
          <NativeButton label="‹" variant="text" onPress={onBack} style={styles.backButton} />
        ) : null}
        <NativeColumn spacing={spacing.xs} style={styles.headerCopy}>
          {eyebrow ? (
            <NativeText variant="micro" color={colors.coralDeep}>
              {eyebrow.toUpperCase()}
            </NativeText>
          ) : null}
          <NativeText variant="title">{title}</NativeText>
          {detail ? <NativeText color={colors.mutedInk}>{detail}</NativeText> : null}
        </NativeColumn>
        {action ? <View style={styles.headerAction}>{action}</View> : null}
      </NativeRow>
      <NativeDivider />
    </NativeColumn>
  );
}

export function SectionHeader({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <NativeRow alignment="center" spacing={spacing.sm}>
      <NativeColumn spacing={spacing.xs} style={styles.headerCopy}>
        <NativeText variant="heading">{title}</NativeText>
        {detail ? <NativeText variant="caption">{detail}</NativeText> : null}
      </NativeColumn>
      {action ? <View style={styles.headerAction}>{action}</View> : null}
    </NativeRow>
  );
}

export function SetupNotice({ detail }: { detail: string }) {
  const theme = useNativeTheme();
  return (
    <NativeHost
      style={[styles.notice, { backgroundColor: theme.accentWash, borderColor: theme.accent }]}
    >
      <NativeColumn spacing={spacing.xs}>
        <NativeText variant="bodyStrong" color={theme.accent}>
          Setup required
        </NativeText>
        <NativeText color={theme.ink}>{detail}</NativeText>
      </NativeColumn>
    </NativeHost>
  );
}

export function RequireSession({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  const router = useRouter();
  React.useEffect(() => {
    if (!loading && !session) router.replace("/sign-in");
  }, [loading, router, session]);
  if (loading) return null;
  if (!session) return null;
  return <>{children}</>;
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const theme = useNativeTheme();
  return (
    <NativeHost
      style={[styles.error, { backgroundColor: theme.dangerWash, borderColor: theme.danger }]}
    >
      <NativeRow alignment="center" spacing={spacing.sm}>
        <NativeText color={theme.danger} style={styles.errorCopy}>
          {message}
        </NativeText>
        {onDismiss ? <NativeButton label="Dismiss" variant="text" onPress={onDismiss} /> : null}
      </NativeRow>
    </NativeHost>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  host: { flex: 1, width: "100%" },
  column: { flex: 1, width: "100%", paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backButton: { minWidth: 42, width: 42 },
  headerCopy: { flex: 1 },
  headerAction: { marginLeft: "auto" },
  notice: { width: "100%", borderWidth: 1, borderRadius: 16, padding: spacing.md },
  error: { width: "100%", borderWidth: 1, borderRadius: 16, padding: spacing.md },
  errorCopy: { flex: 1 },
});
