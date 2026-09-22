const sourceGlob = new Bun.Glob("**/*");
const ignoredFiles = new Set(["bun.lock", ".env.example", "scripts/check-secrets.ts"]);
const ignoredRoots = [".git/", "node_modules/", ".turbo/", "dist/", "build/", ".expo/"];
const binaryExtensions = /\.(?:png|jpe?g|gif|webp|ico|zip|gz|tar|woff2?|ttf|pdf)$/i;
const highConfidencePatterns: readonly [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["OpenAI-style secret", /\bsk-[A-Za-z0-9]{32,}\b/],
];
const findings: string[] = [];

for await (const file of sourceGlob.scan({ cwd: ".", onlyFiles: true })) {
  if (
    ignoredFiles.has(file) ||
    ignoredRoots.some((root) => file.startsWith(root)) ||
    binaryExtensions.test(file)
  )
    continue;
  const source = await Bun.file(file)
    .text()
    .catch(() => "");
  for (const [label, pattern] of highConfidencePatterns) {
    if (pattern.test(source)) findings.push(`${file}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error("Potential secrets found:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Secret scan passed: no high-confidence credential material found.");
