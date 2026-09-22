(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: { apiUrl: "https://muse.example" },
      scheme: "openmuse",
      name: "OpenMuse",
    },
  },
}));
