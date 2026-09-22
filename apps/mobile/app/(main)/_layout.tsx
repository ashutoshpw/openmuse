import React from "react";
import { Tabs } from "expo-router";
import { colors } from "@openmuse/design-tokens";

export default function MainTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.coralDeep,
        tabBarInactiveTintColor: colors.quietInk,
        tabBarStyle: { backgroundColor: colors.paper, borderTopColor: colors.line },
      }}
    >
      <Tabs.Screen name="workspace" options={{ title: "Workspace" }} />
      <Tabs.Screen name="goals" options={{ title: "Goals" }} />
      <Tabs.Screen name="approvals" options={{ title: "Review" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}
