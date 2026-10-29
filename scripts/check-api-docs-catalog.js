#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const registryPath = path.join(repoRoot, "docs/api-integrations.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const errors = [];
const resolvedPackages = new Map();
const markdownPath = path.join(repoRoot, "docs/api-integrations.md");
const skippedDirectories = new Set([".git", "node_modules", "dist", "coverage", ".tmp-contract-check"]);

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

function addError(message) {
  errors.push(message);
}

function parseJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(repoPath(relativePath), "utf8"));
  } catch (error) {
    addError(`${relativePath}: ${error.message}`);
    return null;
  }
}

function validatePackage(reference, entry) {
  const manifest = parseJson(reference.manifest);
  const lockfile = parseJson(reference.lockfile);
  if (!manifest || !lockfile) return;

  const declared = manifest.dependencies?.[reference.name] || manifest.devDependencies?.[reference.name];
  if (!declared) {
    addError(`${entry.id}: ${reference.name} is not declared in ${reference.manifest}`);
    return;
  }
  const locked = lockfile.packages?.[`node_modules/${reference.name}`]?.version;
  if (!locked) {
    addError(`${entry.id}: ${reference.name} has no direct resolved version in ${reference.lockfile}`);
    return;
  }
  resolvedPackages.set(`${reference.manifest}:${reference.name}`, locked);
}

function walk(relativePath, onFile) {
  const absolutePath = repoPath(relativePath);
  if (!fs.existsSync(absolutePath)) {
    addError(`Configured scan path does not exist: ${relativePath}`);
    return;
  }
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    onFile(relativePath, fs.readFileSync(absolutePath, "utf8"));
    return;
  }
  for (const child of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (child.isDirectory() && skippedDirectories.has(child.name)) continue;
    const childPath = path.join(relativePath, child.name);
    if (child.isDirectory()) walk(childPath, onFile);
    else if (/\.(?:c?js|mjs|ts|tsx|jsx)$/.test(child.name)) {
      onFile(childPath, fs.readFileSync(repoPath(childPath), "utf8"));
    }
  }
}

function scanSource() {
  const files = [];
  for (const scanRoot of registry.scanRoots) {
    walk(scanRoot, (relativePath, content) => files.push({ relativePath, content }));
  }

  const detectedPackages = new Set();
  const detectedHosts = new Set();
  const markers = registry.discovery.packageNameMarkers.map((marker) => marker.toLowerCase());
  const hostPrefixes = registry.discovery.hostPrefixes;
  const specialHosts = new Set(registry.discovery.specialHosts);

  for (const manifestPath of registry.packageManifests) {
    const manifest = parseJson(manifestPath);
    if (!manifest) continue;
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const name of Object.keys(dependencies)) {
      if (markers.some((marker) => name.toLowerCase().includes(marker))) {
        detectedPackages.add(`${manifestPath}:${name}`);
      }
    }
  }

  for (const file of files) {
    const urls = file.content.matchAll(/https?:\/\/([a-z0-9.-]+)/gi);
    for (const match of urls) {
      const hostname = match[1].toLowerCase();
      if (hostPrefixes.some((prefix) => hostname.startsWith(prefix)) || specialHosts.has(hostname)) {
        detectedHosts.add(hostname);
      }
    }
  }

  return { detectedPackages, detectedHosts };
}

function validateRegistry() {
  if (registry.schemaVersion !== 1) addError(`Unsupported schemaVersion: ${registry.schemaVersion}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(registry.checkedAt || "")) {
    addError("checkedAt must use YYYY-MM-DD");
  }

  const ids = new Set();
  for (const scanPath of [...(registry.impactScanRoots || []), ...(registry.environmentScanPaths || [])]) {
    if (!fs.existsSync(repoPath(scanPath))) addError(`Impact scan path does not exist: ${scanPath}`);
  }
  for (const entry of registry.entries || []) {
    if (!entry.id || ids.has(entry.id)) addError(`Missing or duplicate integration id: ${entry.id || "(empty)"}`);
    ids.add(entry.id);
    if (!entry.name || !entry.apiVersion) addError(`${entry.id}: name and apiVersion are required`);
    const impactProfile = registry.impactProfiles?.[entry.id];
    if (!impactProfile || !Array.isArray(impactProfile.aliases) || !Array.isArray(impactProfile.envPrefixes)) {
      addError(`${entry.id}: add impact aliases and envPrefixes to the registry`);
    }
    if (!["implemented", "selectable-unverified", "docs-sample"].includes(entry.status)) {
      addError(`${entry.id}: unsupported status ${entry.status}`);
    }
    if (!Array.isArray(entry.docs) || entry.docs.length === 0) addError(`${entry.id}: add at least one official docs URL`);
    for (const doc of entry.docs || []) {
      try {
        const url = new URL(doc.url);
        if (url.protocol !== "https:") addError(`${entry.id}: docs URL must use HTTPS: ${doc.url}`);
        const allowedHosts = registry.officialDocHostSuffixes?.[entry.id] || [];
        if (!allowedHosts.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) {
          addError(`${entry.id}: documentation host is not in its official host allowlist: ${url.hostname}`);
        }
      } catch {
        addError(`${entry.id}: invalid docs URL: ${doc.url}`);
      }
    }
    if (!Array.isArray(entry.codePaths) || entry.codePaths.length === 0) addError(`${entry.id}: add a repository code owner path`);
    for (const codePath of entry.codePaths || []) {
      if (!fs.existsSync(repoPath(codePath))) addError(`${entry.id}: code path does not exist: ${codePath}`);
    }
    for (const packageReference of entry.packages || []) validatePackage(packageReference, entry);
  }

  const discovered = scanSource();
  const registeredPackages = new Set();
  const registeredHosts = new Set();
  for (const entry of registry.entries || []) {
    for (const reference of entry.packages || []) registeredPackages.add(`${reference.manifest}:${reference.name}`);
    for (const hostname of entry.domains || []) registeredHosts.add(hostname.toLowerCase());
  }
  for (const packageReference of discovered.detectedPackages) {
    if (!registeredPackages.has(packageReference)) addError(`Unregistered SDK/integration package: ${packageReference}`);
  }
  for (const hostname of discovered.detectedHosts) {
    if (!registeredHosts.has(hostname)) addError(`Unregistered external API host: ${hostname}`);
  }

  return { discovered, registeredPackages };
}

function renderMarkdown() {
  const rows = registry.entries.map((entry) => {
    const docs = entry.docs.map((doc) => `[${doc.label}](${doc.url})`).join(" · ");
    return `| ${entry.name} | ${entry.status} | ${docs} | ${entry.codePaths.map((item) => `\`${item}\``).join(", ")} | ${entry.apiVersion} |`;
  });
  return `# VOICEDNUT API and SDK documentation index\n\n<!-- Generated from docs/api-integrations.json. Run node scripts/check-api-docs-catalog.js --write-markdown after editing the registry. -->\n\nThis discovery index was last reviewed on **${registry.checkedAt}**. Confirm current behavior at the linked vendor docs and in the current checkout. SDK package versions come from lockfiles; endpoint/API versions are tracked separately.\n\n| API / platform | Status | Official docs and examples | Repository starting points | API version notes |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Internal APIs\n\nThe Mini App and bot also consume VOICEDNUT's own Express routes and action bridge. Use api-contract-change, route implementations, shared contracts, and focused contract coverage as the source of truth. If an internal route proxies an external vendor, review both contracts.\n\n## Change impact\n\nRun \`node scripts/provider-impact.js --list\` to list registry IDs, then \`node scripts/provider-impact.js --provider <id>\` before a provider, SDK, webhook, or version change. The report combines registered owners with source/test references and matching environment variable names. It never reads environment values.\n\n## Registry limits\n\n${registry.notes.map((note) => `- ${note}`).join("\n")}\n`;
}

const { discovered } = validateRegistry();
if (process.argv.includes("--write-markdown") && errors.length === 0) {
  fs.writeFileSync(markdownPath, renderMarkdown());
}
console.log(`API documentation registry: ${registry.entries.length} integrations (${registry.checkedAt})`);
console.log(`Discovered ${discovered.detectedPackages.size} SDK packages and ${discovered.detectedHosts.size} API hosts.`);
for (const [key, version] of resolvedPackages) console.log(`SDK ${key} -> ${version}`);
if (errors.length) {
  console.error(`\n${errors.length} API catalog issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const checkedAgeDays = (Date.now() - Date.parse(`${registry.checkedAt}T00:00:00Z`)) / 86_400_000;
  if (Number.isFinite(checkedAgeDays) && checkedAgeDays > 90) {
    console.warn(`Documentation review date is ${Math.floor(checkedAgeDays)} days old; refresh official API references and update checkedAt.`);
  }
  if (!process.argv.includes("--write-markdown")) {
    let currentMarkdown = "";
    try { currentMarkdown = fs.readFileSync(markdownPath, "utf8"); } catch {}
    if (currentMarkdown !== renderMarkdown()) {
      console.error("Generated API catalog is stale. Run: node scripts/check-api-docs-catalog.js --write-markdown");
      process.exitCode = 1;
    }
  }
  if (process.exitCode === 1) process.exit(1);
  console.log("API documentation catalog coverage is complete for discovered packages and hosts.");
}
