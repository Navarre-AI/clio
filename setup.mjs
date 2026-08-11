#!/usr/bin/env node
// Clio guided installer. Zero dependencies. Two paths:
//   node setup.mjs           interactive Fly.io deploy (app, volume, secrets, deploy, first key)
//   node setup.mjs --local   write a .env for local development and stop
// Flags: --app <name> --region <code> --yes (accept defaults where possible)

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createInterface } from "readline/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : null;
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
// With --yes, take the default and don't ask. A BLANK default is a real
// answer ("no Anthropic key", "no site password"), not a missing one, so it
// must not fall through to a prompt: that hangs an unattended run.
async function askDefault(q, def) {
  if (flag("yes")) return def || "";
  const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def || "";
}
// For answers that have no sensible default and must be chosen deliberately.
async function askRequired(q) {
  for (;;) {
    const a = (await rl.question(`${q}: `)).trim();
    if (a) return a;
    console.log("  Required.");
  }
}
const token = () => randomBytes(18).toString("base64url");
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", cwd: __dirname, ...opts });
const shOut = (cmd) => execSync(cmd, { cwd: __dirname, encoding: "utf8" }).trim();

console.log("\nClio setup. Inviolate logs, outside FileMaker.\n");

if (flag("local")) {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    console.log(".env already exists; not touching it."); process.exit(0);
  }
  const adminToken = token();
  fs.writeFileSync(envPath, [
    `ADMIN_TOKEN=${adminToken}`,
    `SITE_PASSWORD=clio_ui_${token().slice(0, 12)}`,  // never blank: an open dashboard is not a default
    "ANTHROPIC_API_KEY=",
    "PORT=8080",
    "",
  ].join("\n"));
  try { fs.chmodSync(envPath, 0o600); } catch {}  // holds the admin token
  console.log(`Wrote .env with a fresh ADMIN_TOKEN.\n  npm start\nthen mint a key:`);
  console.log(`  curl -s -X POST localhost:8080/v1/admin/keys -H "Authorization: Bearer ${adminToken}" \\`);
  console.log(`    -H "Content-Type: application/json" -d '{"system_id":"my-system","label":"first key"}'`);
  process.exit(0);
}

// ---- Fly deploy path --------------------------------------------------------

try { shOut("flyctl version"); } catch {
  console.error("flyctl is not installed. https://fly.io/docs/flyctl/install/  (or run: node setup.mjs --local)");
  process.exit(1);
}

const appName = String(flag("app") || await askDefault("Fly app name (unique, e.g. clio-acme)", ""));
if (!appName) { console.error("An app name is required."); process.exit(1); }
// No default region. The right one depends on where the FileMaker servers
// that post here live, and a wrong guess is a round trip on every write.
// https://fly.io/docs/reference/regions/
const region = String(flag("region") || await askRequired("Fly region (e.g. fra, iad, syd; nearest your FileMaker server)"));
const adminToken = await askDefault("Admin token (guards key minting)", token());
const sitePassword = await askDefault("Site password for the dashboard (blank = open)", `clio_ui_${token().slice(0, 12)}`);
const aiKey = await askDefault("Anthropic API key (blank = deterministic warnings only, no chat)", "");

const tpl = fs.readFileSync(path.join(__dirname, "fly.template.toml"), "utf8");
fs.writeFileSync(path.join(__dirname, "fly.toml"),
  tpl.replace("{{APP_NAME}}", appName).replace("{{REGION}}", region));
console.log("\nWrote fly.toml.");

sh(`flyctl apps create ${appName}`);
sh(`flyctl volumes create clio_data --app ${appName} --region ${region} --size 1 --yes`);
const secrets = [`ADMIN_TOKEN=${adminToken}`];
if (sitePassword) secrets.push(`SITE_PASSWORD=${sitePassword}`);
if (aiKey) secrets.push(`ANTHROPIC_API_KEY=${aiKey}`);
// Secrets on stdin, not on the command line. An argv is visible to every
// process on the machine via ps, and lands in shell history; these are the
// admin token and the dashboard password.
execSync(`flyctl secrets import --app ${appName} --stage`, {
  input: secrets.join("\n") + "\n", stdio: ["pipe", "inherit", "inherit"], cwd: __dirname,
});
sh(`flyctl deploy --app ${appName}`);

const url = `https://${appName}.fly.dev`;
console.log("\nDeployed. Waiting for the machine to answer…");
for (let i = 0; i < 20; i++) {
  try {
    const r = await fetch(`${url}/health`);
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 3000));
}

const systemId = await askDefault("First system id (names this FileMaker system's chain)", "main");
const label = await askDefault("Key label", `${systemId} initial key`);
let key = null;
try {
  const r = await fetch(`${url}/v1/admin/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ system_id: systemId, label }),
  });
  const body = await r.json();
  key = body?.data?.key || null;
} catch {}

const logUrl = key ? `${url}/v1/log/${key}` : `${url}/v1/log/<your-key>`;
console.log("\n--------------------------------------------------------------");
console.log("Clio is live. The FileMaker side is ONE script (see filemaker/Clio.md).");
console.log("Put this URL in its single Insert from URL step:");
console.log(`\n  ${logUrl}\n`);
console.log("Then set that script as the file's OnWindowTransaction trigger.");
if (sitePassword) console.log(`\n  Dashboard     ${url}   (site password: ${sitePassword})`);
console.log(`  Admin token   ${adminToken}   (store it; shown only here)`);
console.log("--------------------------------------------------------------");
console.log("The key is embedded in the URL above and shown exactly once.");
rl.close();
