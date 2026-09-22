import * as SecureStore from "expo-secure-store";
import type { Session } from "./model";

const SESSION_KEY = "openmuse.session.v1";

export async function loadStoredSession(): Promise<Session | null> {
  const encoded = await SecureStore.getItemAsync(SESSION_KEY);
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded) as Session;
    if (!value.token || !value.user?.id) return null;
    return value;
  } catch {
    await clearStoredSession();
    return null;
  }
}

export async function saveStoredSession(session: Session) {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredSession() {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}
