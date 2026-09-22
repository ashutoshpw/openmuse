import React from "react";
import { useRouter } from "expo-router";
import {
  NativeButton,
  NativeCard,
  NativeColumn,
  NativeText,
  colors,
  spacing,
} from "@openmuse/ui-native";
import { LinkButton } from "../../src/components/LinkButton";
import { PageHeader, RequireSession, Screen, SectionHeader } from "../../src/components/Screen";
import { appConfig } from "../../src/config";
import { useSession } from "../../src/state";

function SettingsContent() {
  const router = useRouter();
  const { session, signOut } = useSession();
  return (
    <Screen>
      <PageHeader
        eyebrow="OpenMuse"
        title="Settings"
        detail="Keep the client small, explicit, and connected to your server."
      />
      <NativeCard>
        <NativeColumn spacing={spacing.sm}>
          <NativeText variant="heading">Account</NativeText>
          <NativeText>{session?.user.name ?? "OpenMuse user"}</NativeText>
          {session?.user.email ? (
            <NativeText variant="caption" color={colors.mutedInk}>
              {session.user.email}
            </NativeText>
          ) : null}
          <NativeText variant="micro" color={colors.quietInk}>
            Session credentials are stored in the device secure store.
          </NativeText>
          <NativeButton
            label="Sign out"
            variant="outlined"
            onPress={() => void signOut().then(() => router.replace("/sign-in"))}
          />
        </NativeColumn>
      </NativeCard>
      <NativeCard>
        <NativeColumn spacing={spacing.sm}>
          <NativeText variant="heading">Server</NativeText>
          <NativeText variant="caption" color={colors.mutedInk}>
            {appConfig.apiUrl ?? "Not configured"}
          </NativeText>
          <NativeText variant="micro" color={colors.quietInk}>
            Change EXPO_PUBLIC_OPENMUSE_API_URL in the development build environment to use another
            server.
          </NativeText>
        </NativeColumn>
      </NativeCard>
      <SectionHeader title="Workspace controls" />
      <NativeColumn spacing={spacing.sm}>
        <LinkButton label="Provider connections" href="/providers" variant="outlined" />
        <LinkButton label="Memory" href="/memory" variant="outlined" />
        <LinkButton label="Sharing" href="/sharing" variant="outlined" />
        <LinkButton label="AppConnect callback" href="/connect/link" variant="text" />
      </NativeColumn>
    </Screen>
  );
}

export default function SettingsRoute() {
  return (
    <RequireSession>
      <SettingsContent />
    </RequireSession>
  );
}
