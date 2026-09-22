import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { NativeThemeProvider } from "@openmuse/ui-native";
import { AppProviders } from "../src/state";

export default function RootLayout() {
  return (
    <NativeThemeProvider>
      <AppProviders>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
      </AppProviders>
    </NativeThemeProvider>
  );
}
