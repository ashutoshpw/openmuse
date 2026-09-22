import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import {
  NativeButton,
  NativeCard,
  NativeColumn,
  NativeHost,
  NativeText,
  colors,
  spacing,
  useNativeTheme,
} from "@openmuse/ui-native";
import { FieldLabel } from "../src/components/FieldLabel";
import { SetupNotice } from "../src/components/Screen";
import { useApi, useSession } from "../src/state";

export default function SignInRoute() {
  const theme = useNativeTheme();
  const apiState = useApi();
  const { signIn, signingIn, error } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async () => {
    setLocalError(null);
    if (!email.trim() || !password) {
      setLocalError("Enter the email and password for your OpenMuse account.");
      return;
    }
    try {
      await signIn(email.trim(), password);
    } catch {
      // SessionProvider exposes the server-backed error below.
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.safe, { backgroundColor: theme.background }]}
    >
      <NativeHost style={styles.host}>
        <NativeColumn spacing={spacing.xl} style={styles.content}>
          <NativeColumn spacing={spacing.sm}>
            <NativeText variant="micro" color={colors.coralDeep}>
              OPENMUSE / PRIVATE AGENT
            </NativeText>
            <NativeText variant="display">A calmer place to get things done.</NativeText>
            <NativeText color={colors.mutedInk}>
              Your work, memory, and approvals stay inside the workspace you choose.
            </NativeText>
          </NativeColumn>
          {!apiState.configured ? (
            <SetupNotice detail={apiState.error ?? "Configure the server URL before signing in."} />
          ) : null}
          {apiState.configured ? (
            <NativeCard>
              <NativeColumn spacing={spacing.md}>
                <NativeText variant="heading">Sign in to your workspace</NativeText>
                <FieldLabel
                  label="Email"
                  placeholder="you@example.com"
                  autoCapitalize="none"
                  onChangeText={setEmail}
                  keyboardType="email-address"
                />
                <FieldLabel
                  label="Password"
                  placeholder="Your password"
                  secureTextEntry
                  onChangeText={setPassword}
                />
                {localError || error ? (
                  <NativeText color={colors.danger}>{localError ?? error ?? ""}</NativeText>
                ) : null}
                <NativeButton
                  label={signingIn ? "Signing in…" : "Continue"}
                  onPress={() => void submit()}
                  disabled={signingIn}
                />
              </NativeColumn>
            </NativeCard>
          ) : null}
          <View style={styles.footer}>
            <NativeText variant="caption" color={colors.quietInk}>
              Hosted or self-hosted. API credentials are kept on the server.
            </NativeText>
          </View>
        </NativeColumn>
      </NativeHost>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  host: { flex: 1 },
  content: { flex: 1, justifyContent: "center", padding: spacing.xl },
  footer: { marginTop: "auto", paddingTop: spacing.xl },
});
