type BoundaryRule = {
  label: string;
  roots: readonly string[];
  forbidden: readonly string[];
};

const rules: readonly BoundaryRule[] = [
  {
    label: "core stays provider- and persistence-agnostic",
    roots: ["packages/core/"],
    forbidden: [
      "@openmuse/db",
      "@openmuse/application",
      "@openmuse/client",
      "drizzle-orm",
      "postgres",
    ],
  },
  {
    label: "provider contracts stay independent of app and persistence",
    roots: ["packages/provider-contracts/"],
    forbidden: ["@openmuse/db", "@openmuse/application", "@openmuse/client", "@openmuse/auth"],
  },
  {
    label: "provider implementations do not reach into app persistence",
    roots: ["packages/providers/"],
    forbidden: ["@openmuse/db", "@openmuse/application", "@openmuse/auth"],
  },
  {
    label: "web uses the HTTP client boundary",
    roots: ["apps/web/"],
    forbidden: ["@openmuse/db", "@openmuse/auth", "@openmuse/application"],
  },
  {
    label: "mobile uses the HTTP client boundary",
    roots: ["apps/mobile/"],
    forbidden: ["@openmuse/db", "@openmuse/auth", "@openmuse/application", "@openmuse/providers"],
  },
];

const sourcePattern = /(?:from\s*|import\s*\(|require\s*\()(?:type\s*)?["']([^"']+)["']/g;
const ignoredRoots = ["node_modules/", ".git/", ".turbo/", "dist/", "build/", ".expo/"];
const sourceGlob = new Bun.Glob("**/*.{js,jsx,ts,tsx}");
const violations: string[] = [];

for await (const file of sourceGlob.scan({ cwd: ".", onlyFiles: true })) {
  if (ignoredRoots.some((root) => file.startsWith(root))) continue;
  const rule = rules.find((candidate) => candidate.roots.some((root) => file.startsWith(root)));
  if (!rule) continue;
  const source = await Bun.file(file).text();
  for (const match of source.matchAll(sourcePattern)) {
    const imported = match[1];
    if (
      imported &&
      rule.forbidden.some((prefix) => imported === prefix || imported.startsWith(`${prefix}/`))
    ) {
      violations.push(`${file}: ${imported} (${rule.label})`);
    }
  }
}

if (violations.length > 0) {
  console.error("Import boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Import boundaries passed (${rules.length} rules).`);
