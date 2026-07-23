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
async function askDefault(q, def) {
  if (flag("yes") && def) return def;
  const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def || "";
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
    "SITE_PASSWORD=",
    "ANTHROPIC_API_KEY=",
    "PORT=8080",
    "",
  ].join("\n"));
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
const region = String(flag("region") || await askDefault("Fly region", "sjc"));
const adminToken = await askDefault("Admin token (guards key minting)", token());
const sitePassword = await askDefault("Site password for the web UI (blank = open)", token().slice(0, 12));
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
sh(`flyctl secrets set ${secrets.join(" ")} --app ${appName} --stage`);
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

console.log("\n--------------------------------------------------------------");
console.log("Clio is live. Values for the FileMaker side (see filemaker/):");
console.log(`  ClioSettings::ClioURL     ${url}`);
console.log(`  ClioSettings::ClioAPIKey  ${key || "(minting failed; mint manually, see README)"}`);
if (sitePassword) console.log(`  Web UI                    ${url}/?key=${sitePassword}`);
console.log(`  Admin token               ${adminToken}   (store it; shown only here)`);
console.log("--------------------------------------------------------------");
console.log("The API key above is shown exactly once. Put it in ClioSettings now.");
rl.close();
