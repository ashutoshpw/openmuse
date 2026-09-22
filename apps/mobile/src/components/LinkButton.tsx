import React from "react";
import { Linking } from "react-native";
import { useRouter } from "expo-router";
import { NativeButton } from "@openmuse/ui-native";

function isExternalHref(href: string) {
  return /^[a-z][a-z\d+.-]*:/i.test(href);
}

export function LinkButton({
  label,
  href,
  variant = "text",
}: {
  label: string;
  href: string;
  variant?: "filled" | "outlined" | "text";
}) {
  const router = useRouter();
  const onPress = () => {
    if (isExternalHref(href)) {
      void Linking.openURL(href).catch(() => undefined);
      return;
    }
    router.push(href as never);
  };
  return <NativeButton label={label} onPress={onPress} variant={variant} />;
}
