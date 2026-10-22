import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

type Client = { id: string; key_sha256: string; enabled: boolean };
type Store = { version: 1; clients: Client[] };
const args = process.argv.slice(2);
const [command, clientId, rawPath = "config/ai-clients.json"] = args;
const secretFileIndex = args.indexOf("--secret-file");
const secretFile = secretFileIndex >= 0 ? args[secretFileIndex + 1] : undefined;
if (!command || !clientId || !["create", "revoke", "enable"].includes(command)) {
  console.error("usage: node scripts/client-key.ts create|revoke|enable <client-id> [key-file] [--secret-file <path>]"); process.exitCode = 1;
} else if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(clientId)) {
  console.error("client-id must use lowercase letters, digits, dot, underscore, or hyphen"); process.exitCode = 1;
} else {
  const path = resolve(rawPath); const store = readStore(path); const existing = store.clients.find((client) => client.id === clientId);
  if (command === "create") {
    if (existing?.enabled) throw new Error("client already has an active key; revoke it before replacing the key");
    const secret = randomBytes(32).toString("base64url"); const record = { id: clientId, key_sha256: createHash("sha256").update(secret).digest("hex"), enabled: true };
    if (secretFile) {
      const resolvedSecretFile = resolve(secretFile);
      if (existsSync(resolvedSecretFile)) throw new Error("secret file already exists");
      mkdirSync(dirname(resolvedSecretFile), { recursive: true }); writeFileSync(resolvedSecretFile, secret, { mode: 0o600 }); chmodSync(resolvedSecretFile, 0o600);
    }
    store.clients = [...store.clients.filter((client) => client.id !== clientId), record].sort((a, b) => a.id.localeCompare(b.id)); writeStore(path, store);
    console.log(`client key created for ${clientId}`);
    if (secretFile) console.log("plaintext key stored in the requested local mode-0600 secret file; value not displayed");
    else { console.log("Copy this secret now; it will not be stored or shown again:"); console.log(secret); }
  } else {
    if (!existing) throw new Error("client does not exist"); existing.enabled = command === "enable"; writeStore(path, store);
    console.log(`${clientId}: ${existing.enabled ? "enabled" : "revoked"}`);
  }
}

function readStore(path: string): Store {
  if (!existsSync(path)) return { version: 1, clients: [] };
  const value = JSON.parse(readFileSync(path, "utf8")) as Store;
  if (value.version !== 1 || !Array.isArray(value.clients)) throw new Error("client key file is invalid");
  return value;
}
function writeStore(path: string, store: Store): void {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 }); chmodSync(path, 0o600);
}
