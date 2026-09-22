const workflowGlob = new Bun.Glob(".github/workflows/*.{yml,yaml}");
const workflows: string[] = [];
const failures: string[] = [];
const actionPattern = /^\s*uses:\s*([^@\s]+)@([^\s#]+)/gm;

for await (const file of workflowGlob.scan({ cwd: ".", onlyFiles: true })) {
  workflows.push(file);
  const source = await Bun.file(file).text();
  if (!/^permissions:\s*$/m.test(source) && !/^permissions:\s*\S+/m.test(source))
    failures.push(`${file}: define an explicit least-privilege permissions block`);
  if (source.includes("pull_request_target"))
    failures.push(`${file}: pull_request_target is not permitted for repository code`);
  if (source.includes("persist-credentials: true"))
    failures.push(`${file}: checkout credentials must not persist`);
  if (source.includes("--no-verify")) failures.push(`${file}: hook bypass flags are forbidden`);
  for (const match of source.matchAll(actionPattern)) {
    const action = match[1];
    const reference = match[2];
    if (
      action &&
      reference &&
      !action.startsWith("docker://") &&
      !/^[0-9a-f]{40}$/i.test(reference)
    )
      failures.push(`${file}: action ${action} must be pinned to a full commit SHA`);
  }
}

if (workflows.length === 0) failures.push(".github/workflows: at least one workflow is required");
if (workflows.some((file) => file.endsWith("ci.yml"))) {
  const ci = await Bun.file(workflows.find((file) => file.endsWith("ci.yml"))!).text();
  if (!ci.includes("aggregate:"))
    failures.push(".github/workflows/ci.yml: stable aggregate job is required");
}

if (failures.length > 0) {
  console.error("Workflow checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Workflow checks passed (${workflows.length} workflow files).`);
