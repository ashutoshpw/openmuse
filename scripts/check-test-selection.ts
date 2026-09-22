import { readFile } from "node:fs/promises";

const rootVitest = await readFile("vitest.config.ts", "utf8");
const rootPackage = JSON.parse(await readFile("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const mobilePackage = JSON.parse(await readFile("apps/mobile/package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const webPackage = JSON.parse(await readFile("apps/web/package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const webRunner = await readFile("scripts/test-web.sh", "utf8");
const nativeRunner = await readFile("scripts/test-native.sh", "utf8");
const authRunner = await readFile("scripts/test-auth.sh", "utf8");
const failures: string[] = [];

function requireText(text: string, needle: string, label: string): void {
  if (!text.includes(needle)) failures.push(`${label} must contain ${needle}`);
}

requireText(rootVitest, '"**/e2e/**"', "root Vitest exclusion");
requireText(rootVitest, '"apps/mobile/**"', "root Vitest exclusion");
requireText(rootVitest, '"**/*.integration.test.*"', "root Vitest exclusion");
requireText(rootVitest, '"**/*.native.test.*"', "root Vitest exclusion");
requireText(rootVitest, '"**/*.native.spec.*"', "root Vitest exclusion");
requireText(rootPackage.scripts?.test ?? "", "test:unit", "root test script");
requireText(rootPackage.scripts?.["test:auth"] ?? "", "test-auth", "auth integration script");
requireText(rootPackage.scripts?.["test:native"] ?? "", "test-native", "native test script");
requireText(authRunner, "*.integration.test.ts", "database integration runner");
requireText(authRunner, "TEST_DATABASE_URL", "auth integration database guard");
requireText(nativeRunner, "bun run test", "native test runner");
requireText(rootPackage.scripts?.["test:web"] ?? "", "test-web", "web test script");
requireText(webRunner, "test:e2e", "web test runner");
requireText(mobilePackage.scripts?.test ?? "", "jest", "mobile test script");
requireText(webPackage.scripts?.["test:e2e"] ?? "", "playwright", "web e2e script");

if (failures.length > 0) {
  console.error("Test selection checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "Test selection passed: unit, database integration, native Jest, and web Playwright suites are separated.",
);
