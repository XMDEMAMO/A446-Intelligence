import { readFile } from "node:fs/promises";
import path from "node:path";

const evidencePath = process.argv[2];
if (!evidencePath) {
  console.error("Usage: node verify-release-evidence.mjs <release-evidence.json>");
  process.exit(2);
}

const evidence = JSON.parse(await readFile(path.resolve(evidencePath), "utf8"));
const required = [
  "checkAll",
  "browserE2E",
  "postgresql",
  "dependencyAudit",
  "backupRestore",
  "versionRollback",
  "workerRestart",
  "httpsWss",
  "realMultiDevice",
];
const failures = [];
for (const key of required) {
  const item = evidence[key];
  if (!item || item.status !== "passed") failures.push(`${key}: status must be passed`);
  if (!item?.recordedAt || Number.isNaN(Date.parse(item.recordedAt))) failures.push(`${key}: recordedAt must be an ISO timestamp`);
  if (!Array.isArray(item?.evidence) || item.evidence.length === 0 || item.evidence.some((value) => typeof value !== "string" || !value.trim())) {
    failures.push(`${key}: evidence must contain at least one non-empty reference`);
  }
}
if (!evidence.baseSha || !/^[a-f0-9]{7,40}$/i.test(evidence.baseSha)) failures.push("baseSha: required Git revision");
if (!evidence.releaseHead || !/^[a-f0-9]{7,40}$/i.test(evidence.releaseHead)) failures.push("releaseHead: required Git revision");
if (failures.length > 0) {
  console.error(["Release evidence is incomplete:", ...failures.map((item) => `- ${item}`)].join("\n"));
  process.exit(1);
}
console.log(`Release evidence is complete for ${evidence.releaseHead}.`);
