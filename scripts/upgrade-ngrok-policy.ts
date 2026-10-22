import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/upgrade-ngrok-policy.ts <existing-policy-file>");
const source = readFileSync(path, "utf8");
const doorPaths = [
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/register",
  "/oauth/google/callback",
  "/oauth/consent",
];
const doorMembership = `req.url.path in [${doorPaths.map((item) => `'${item}'`).join(", ")}]`;
const bypass = `(req.url.path.startsWith('/ai/v1/') || ${doorMembership})`;
if (source.includes("/.well-known/oauth-protected-resource/mcp")) {
  console.log("ngrok policy already has the Common Door exact-path boundary");
  process.exit(0);
}
const oauthNeedle = "  - actions:\n      - type: oauth";
const denyPattern = /  - expressions:\n      - "!\(actions\.ngrok\.oauth\.identity\.email in \[([^\n]+)\]\)"\n    actions:\n      - type: deny/;
let updated: string;
if (source.includes("!req.url.path.startsWith('/ai/v1/')")) {
  updated = source
    .replaceAll("!req.url.path.startsWith('/ai/v1/')", `!${bypass}`);
} else {
  if (!source.includes(oauthNeedle) || !denyPattern.test(source)) throw new Error("ngrok policy shape is not the expected Google OAuth allow-one-user policy; no change made");
  updated = source.replace(oauthNeedle, `  - expressions:\n      - \"!${bypass}\"\n    actions:\n      - type: oauth`);
  updated = updated.replace(denyPattern, (_whole, allowlist: string) => `  - expressions:\n      - \"!${bypass} && !(actions.ngrok.oauth.identity.email in [${allowlist}])\"\n    actions:\n      - type: deny`);
}
const backup = `${path}.pre-common-door.backup`;
copyFileSync(path, backup); chmodSync(backup, 0o600);
writeFileSync(path, updated, { mode: 0o600 }); chmodSync(path, 0o600);
console.log("ngrok policy updated: Google OAuth remains on browser paths; /ai/v1/ and the Common Door exact paths bypass only the ngrok browser OAuth layer");
console.log("backup created without displaying identity data");
