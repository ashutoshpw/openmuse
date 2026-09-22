import { access } from "node:fs/promises";

for (const file of ["LICENSE", "THIRD_PARTY_NOTICES", "bun.lock"]) {
  try {
    await access(file);
  } catch {
    console.error(`License check requires ${file}.`);
    process.exit(1);
  }
}

const result = Bun.spawnSync(
  ["bunx", "--bun", "license-checker", "--production", "--summary", "--excludePrivatePackages"],
  { stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) process.exit(result.exitCode);
console.log("License check passed; dependency licenses were resolved from the frozen install.");
