import React, { useCallback } from "react";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import type { ChatPart } from "../../data/model";
import {
  NativeBadge,
  NativeColumn,
  NativeHost,
  NativeText,
  colors,
  radii,
  spacing,
  useNativeTheme,
} from "@openmuse/ui-native";
import { EmptyState } from "../../components/ResourceStates";

function MessageBubble({ part }: { part: ChatPart }) {
  const theme = useNativeTheme();
  const isUser = part.role === "user";
  const isTool = part.role === "tool" || part.kind === "tool";
  const background = isUser ? theme.accent : isTool ? colors.skyWash : theme.surface;
  const foreground = isUser ? colors.white : theme.ink;
  return (
    <View style={[styles.row, isUser ? styles.userRow : styles.assistantRow]}>
      <NativeHost
        matchContents={{ vertical: true }}
        style={[
          styles.bubble,
          { backgroundColor: background, borderColor: isUser ? theme.accent : theme.line },
        ]}
      >
        <NativeColumn spacing={spacing.xs}>
          <NativeText variant="micro" color={isUser ? colors.coralWash : theme.quietInk}>
            {isUser ? "YOU" : isTool ? "WORK" : "MUSE"}
          </NativeText>
          <NativeText color={foreground}>{part.text || " "}</NativeText>
          {part.streaming ? <NativeBadge tone="accent">LIVE</NativeBadge> : null}
        </NativeColumn>
      </NativeHost>
    </View>
  );
}

export function ChatTranscript({
  parts,
  onReachEnd,
  style,
}: {
  parts: ChatPart[];
  onReachEnd?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const renderItem = useCallback<ListRenderItem<ChatPart>>(
    ({ item }) => <MessageBubble part={item} />,
    [],
  );
  if (parts.length === 0) {
    return (
      <EmptyState
        title="Start with an outcome"
        detail="Ask OpenMuse to research, create, or change something in this workspace."
      />
    );
  }
  return (
    <FlashList
      contentContainerStyle={styles.content}
      data={parts}
      keyExtractor={(item) => item.id}
      onEndReached={onReachEnd}
      onEndReachedThreshold={0.2}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      style={style}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  row: { width: "100%", marginBottom: spacing.md },
  userRow: { alignItems: "flex-end" },
  assistantRow: { alignItems: "flex-start" },
  bubble: { maxWidth: "92%", borderWidth: 1, borderRadius: radii.lg, padding: spacing.md },
});
