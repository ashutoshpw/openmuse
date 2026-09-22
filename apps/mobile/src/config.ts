import Constants from "expo-constants";

function resolveApiUrl() {
  const configured = Constants.expoConfig?.extra?.apiUrl;
  const env = process.env.EXPO_PUBLIC_OPENMUSE_API_URL;
  const value =
    typeof configured === "string" && configured.startsWith("${") ? env : (configured ?? env);
  return typeof value === "string" && value.trim() !== "" ? value.replace(/\/$/, "") : null;
}

export const appConfig = {
  apiUrl: resolveApiUrl(),
  scheme: Constants.expoConfig?.scheme ?? "openmuse",
  appName: Constants.expoConfig?.name ?? "OpenMuse",
} as const;

export function requireApiUrl() {
  if (!appConfig.apiUrl) {
    throw new Error(
      "OpenMuse is not configured. Set EXPO_PUBLIC_OPENMUSE_API_URL before starting the mobile app.",
    );
  }
  return appConfig.apiUrl;
}
