#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "docs/api-integrations.json"), "utf8"));
const skipDirectories = new Set([".git", "node_modules", "dist", "coverage", ".tmp-contract-check"]);

function printUsage() {
  console.log("Usage: node scripts/provider-impact.js --provider <registry-id>");
  console.log("       node scripts/provider-impact.js --list");
}

function walk(relativePath, visit) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    visit(relativePath, fs.readFileSync(absolutePath, "utf8"));
    return;
  }
  for (const child of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (child.isDirectory() && skipDirectories.has(child.name)) continue;
    const childPath = path.join(relativePath, child.name);
    if (child.isDirectory()) walk(childPath, visit);
    else if (/\.(?:c?js|mjs|ts|tsx|jsx)$/.test(child.name)) {
      visit(childPath, fs.readFileSync(path.join(root, childPath), "utf8"));
    }
  }
}

function resolvePackageVersion(packageReference) {
  const lockfilePath = path.join(root, packageReference.lockfile);
  if (!fs.existsSync(lockfilePath)) return "lockfile missing";
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  return lockfile.packages?.[`node_modules/${packageReference.name}`]?.version || "version not resolved";
}

function collectReferences(entry, profile) {
  const rawTerms = [
    entry.id,
    ...(profile.aliases || []),
    ...entry.packages.map((item) => item.name),
    ...entry.domains,
  ];
  const terms = [...new Set(rawTerms.map((term) => String(term).toLowerCase()).filter((term) => term.length > 2))];
  const termPatterns = terms.map((term) => new RegExp(
    /^[a-z0-9]+$/.test(term) ? `(^|[^a-z0-9])${term}([^a-z0-9]|$)` : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  ));
  const codeReferences = [];
  const testReferences = [];
  const envReferences = new Map();
  const registeredOwners = new Set(entry.codePaths);
  const configuredEnvNames = new Set(profile.envVars || []);
  const prefixes = profile.envPrefixes || [];
  const envPattern = /\b(?:readEnv|ensure|envValue)\s*\(\s*["']([A-Z][A-Z0-9_]+)["']|\bprocess\.env\.([A-Z][A-Z0-9_]+)/g;

  for (const scanRoot of registry.impactScanRoots) {
    walk(scanRoot, (relativePath, content) => {
      const lines = content.split(/\r?\n/);
      const hits = [];
      for (let index = 0; index < lines.length; index += 1) {
        if (termPatterns.some((pattern) => pattern.test(lines[index]))) hits.push(index + 1);
      }
      if (hits.length) {
        const reference = { path: relativePath, lines: hits.slice(0, 8), total: hits.length };
        if (/(__tests__|\.test\.|\.spec\.|\/e2e\/)/i.test(relativePath)) testReferences.push(reference);
        else if (!registeredOwners.has(relativePath)) codeReferences.push(reference);
      }
    });
  }

  for (const relativePath of registry.environmentScanPaths) {
    if (!fs.existsSync(path.join(root, relativePath))) continue;
    const content = fs.readFileSync(path.join(root, relativePath), "utf8");
    for (const match of content.matchAll(envPattern)) {
      const name = match[1] || match[2];
      if (!configuredEnvNames.has(name) && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const lineNumber = content.slice(0, match.index).split(/\r?\n/).length;
      if (!envReferences.has(name)) envReferences.set(name, new Set());
      envReferences.get(name).add(`${relativePath}:${lineNumber}`);
    }
  }

  return { codeReferences, testReferences, envReferences };
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const entry of registry.entries) console.log(`${entry.id}\t${entry.name}\t${entry.status}`);
  process.exit(0);
}

const providerIndex = args.indexOf("--provider");
const selectedId = providerIndex >= 0 ? args[providerIndex + 1] : null;
if (!selectedId) {
  printUsage();
  process.exitCode = 2;
} else {
  const entry = registry.entries.find((item) => item.id.toLowerCase() === selectedId.toLowerCase());
  if (!entry) {
    console.error(`Unknown integration: ${selectedId}`);
    printUsage();
    process.exitCode = 2;
  } else {
    const profile = registry.impactProfiles?.[entry.id] || {};
    const { codeReferences, testReferences, envReferences } = collectReferences(entry, profile);
    console.log(`# Change impact: ${entry.name}`);
    console.log(`Registry id: ${entry.id} | status: ${entry.status}`);
    console.log(`API version notes: ${entry.apiVersion}`);

    console.log("\n## SDK packages (resolved from lockfiles)");
    if (!entry.packages.length) console.log("- No direct SDK package is recorded; integration uses direct HTTP or a provider-specific adapter.");
    for (const reference of entry.packages) {
      console.log(`- ${reference.name}: ${resolvePackageVersion(reference)} (${reference.manifest}; ${reference.lockfile})`);
    }

    console.log("\n## Registered implementation owners");
    for (const codePath of entry.codePaths) console.log(`- ${codePath}`);

    console.log("\n## Additional code references");
    if (!codeReferences.length) console.log("- No additional text references found by the configured search terms.");
    for (const reference of codeReferences) {
      console.log(`- ${reference.path}:${reference.lines.join(",")}${reference.total > reference.lines.length ? ` (+${reference.total - reference.lines.length} more matching lines)` : ""}`);
    }

    console.log("\n## Test references");
    if (!testReferences.length) console.log("- No matching test paths found; add focused stubbed-provider coverage if this change affects behavior.");
    for (const reference of testReferences) {
      console.log(`- ${reference.path}:${reference.lines.join(",")}${reference.total > reference.lines.length ? ` (+${reference.total - reference.lines.length} more matching lines)` : ""}`);
    }

    console.log("\n## Environment variable names (values are never read)");
    if (!envReferences.size) console.log("- No matching names found in the configured environment files.");
    for (const [name, sources] of [...envReferences.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`- ${name}: ${[...sources].join(", ")}`);
    }

    console.log("\n## Official documentation");
    for (const doc of entry.docs) console.log(`- ${doc.label}: ${doc.url}`);

    console.log("\n## Review checklist");
    console.log("- Check the current official endpoint/version docs and reconcile them with this API version note.");
    console.log("- Review every listed owner, added reference, consumer, and matching test before editing.");
    console.log("- Preserve auth, tenant scope, consent, idempotency, replay protection, limits, and approval gates where applicable.");
    console.log("- Update docs/api-integrations.json and regenerate docs/api-integrations.md if integration metadata changes.");
  }
}
