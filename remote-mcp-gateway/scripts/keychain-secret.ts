import { stdin } from "node:process";
import { MacKeychainSecretStore } from "../src/keychain.ts";

const [command, service, account] = process.argv.slice(2);
if (!service || !account || !["set", "delete", "exists"].includes(command ?? "")) {
  throw new Error("usage: keychain-secret.ts set|delete|exists <service> <account>");
}
const store = new MacKeychainSecretStore(service);
if (command === "exists") {
  console.log(store.get(account) ? "secret exists" : "secret is missing");
} else if (command === "delete") {
  store.delete(account); console.log("secret deleted from macOS Keychain");
} else {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  store.set(account, secret.trim());
  console.log("secret stored in macOS Keychain; value not displayed");
}
