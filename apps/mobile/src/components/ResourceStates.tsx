import React from "react";
import { NativeEmptyState, NativeErrorState, NativeLoadingState } from "@openmuse/ui-native";

export function LoadingState({ label }: { label?: string }) {
  return <NativeLoadingState label={label} />;
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return <NativeEmptyState action={action} detail={detail} title={title} />;
}

export function ErrorState({ detail, onRetry }: { detail: string; onRetry?: () => void }) {
  return <NativeErrorState detail={detail} onRetry={onRetry} />;
}
