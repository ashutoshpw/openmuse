import React from "react";
import type { KeyboardTypeOptions } from "react-native";
import { NativeColumn, NativeField, NativeText, spacing } from "@openmuse/ui-native";

export function FieldLabel({
  label,
  detail,
  ...fieldProps
}: {
  label: string;
  detail?: string;
  placeholder?: string;
  defaultValue?: string;
  onChangeText?: (value: string) => void;
  onSubmitEditing?: (event: unknown) => void;
  secureTextEntry?: boolean;
  multiline?: boolean;
  numberOfLines?: number;
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
  keyboardType?: KeyboardTypeOptions;
  editable?: boolean;
  testID?: string;
}) {
  return (
    <NativeColumn spacing={spacing.xs}>
      <NativeText variant="caption">{label}</NativeText>
      {detail ? <NativeText variant="micro">{detail}</NativeText> : null}
      <NativeField {...fieldProps} />
    </NativeColumn>
  );
}
