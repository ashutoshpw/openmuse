const fs = require("node:fs");
const path = require("node:path");

function resolveBabelRuntime() {
  const bunStore = path.resolve(__dirname, "../../node_modules/.bun");
  const packageDirectory = fs
    .readdirSync(bunStore)
    .find((entry) => entry.startsWith("@babel+runtime@"));
  return packageDirectory
    ? path.resolve(bunStore, packageDirectory, "node_modules/@babel/runtime")
    : null;
}

const babelRuntime = resolveBabelRuntime();

module.exports = {
  preset: "jest-expo/node",
  setupFiles: [],
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/src/**/*.test.tsx"],
  setupFilesAfterEnv: ["<rootDir>/src/test/setup.ts"],
  moduleNameMapper: {
    ...(babelRuntime ? { "^@babel/runtime/(.*)$": `${babelRuntime}/$1` } : {}),
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@openmuse/design-tokens$": "<rootDir>/../../packages/design-tokens/src/index.ts",
    "^@openmuse/ui-native$": "<rootDir>/../../packages/ui-native/src/index.tsx",
    "^expo-constants$": "<rootDir>/src/test/mocks/expo-constants.js",
  },
};
