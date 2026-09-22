import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  NativeButton,
  NativeField,
  NativeHost,
  NativeRow,
  NativeText,
  colors,
  spacing,
  useNativeTheme,
} from "@openmuse/ui-native";
import type { VoiceState } from "../voice/useVoice";

export function ChatComposer({
  onSend,
  onAttach,
  onVoice,
  voiceState,
  disabled,
}: {
  onSend: (text: string) => Promise<void> | void;
  onAttach?: () => void;
  onVoice?: () => void;
  voiceState?: VoiceState;
  disabled?: boolean;
}) {
  const theme = useNativeTheme();
  const [draft, setDraft] = useState("");
  const [draftKey, setDraftKey] = useState(0);
  const canSend = draft.trim().length > 0 && !disabled;
  const voiceLabel = useMemo(() => {
    if (voiceState === "connecting") return "…";
    if (voiceState === "listening") return "■";
    if (voiceState === "error") return "!";
    return "◉";
  }, [voiceState]);

  const send = async () => {
    if (!canSend) return;
    const text = draft.trim();
    await onSend(text);
    setDraft("");
    setDraftKey((value) => value + 1);
  };

  return (
    <NativeHost style={[styles.host, { backgroundColor: theme.surface, borderColor: theme.line }]}>
      <NativeField
        key={draftKey}
        multiline
        numberOfLines={3}
        onChangeText={setDraft}
        onSubmitEditing={() => void send()}
        placeholder="Ask for an outcome…"
        testID="chat-composer"
      />
      <NativeRow alignment="center" spacing={spacing.sm} style={styles.actions}>
        <NativeButton label="Attach" onPress={onAttach} variant="text" disabled={disabled} />
        <View style={styles.grow} />
        <NativeButton
          label={voiceLabel}
          onPress={onVoice}
          variant="outlined"
          disabled={disabled}
          testID="voice-button"
        />
        <NativeButton
          label="Send"
          onPress={() => void send()}
          disabled={!canSend}
          testID="send-button"
        />
      </NativeRow>
      <NativeText variant="micro" color={colors.quietInk}>
        OpenMuse will ask before external actions. Stop keeps your draft.
      </NativeText>
    </NativeHost>
  );
}

const styles = StyleSheet.create({
  host: { width: "100%", borderWidth: 1, borderRadius: 20, padding: spacing.sm, gap: spacing.sm },
  actions: { width: "100%" },
  grow: { flex: 1 },
});
