import React, { useEffect } from "react";
import { useRouter } from "expo-router";
import { NativeLoadingState } from "@openmuse/ui-native";
import { useSession } from "../src/state";

export default function IndexRoute() {
  const router = useRouter();
  const { session, loading } = useSession();

  useEffect(() => {
    if (loading) return;
    router.replace((session ? "/(main)/workspace" : "/sign-in") as never);
  }, [loading, router, session]);

  return <NativeLoadingState label="Opening your private workspace…" />;
}
