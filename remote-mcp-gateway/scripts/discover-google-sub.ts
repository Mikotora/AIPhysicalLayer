import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { MacKeychainSecretStore } from "../src/keychain.ts";
import {
  GOOGLE_SUB_DISCOVERY_HOST,
  GOOGLE_SUB_DISCOVERY_PORT,
  GOOGLE_SUB_DISCOVERY_REDIRECT_URI,
  createGoogleSubDiscoverySession,
} from "../src/google-sub-discovery.ts";

const configFile = process.argv[2];
if (!configFile) throw new Error("gateway personal configuration path is required");
const config = object(JSON.parse(readFileSync(configFile, "utf8")));
const clientId = required(config?.googleClientId, "googleClientId");
const keychainService = required(config?.keychainService, "keychainService");
const secretAccount = required(config?.googleClientSecretAccount, "googleClientSecretAccount");
const clientSecret = new MacKeychainSecretStore(keychainService).get(secretAccount);
if (!clientSecret) throw new Error("Google OAuth client secret is missing from macOS Keychain");

const session = createGoogleSubDiscoverySession({ clientId, clientSecret });
const timeout = setTimeout(() => {
  console.error("Google sub確認は5分で期限切れになりました。値は保存していません。");
  session.server.close();
}, 5 * 60 * 1_000);

session.server.once("close", () => clearTimeout(timeout));
session.server.once("error", (error) => {
  clearTimeout(timeout);
  console.error(error instanceof Error && "code" in error && error.code === "EADDRINUSE"
    ? `localhost:${GOOGLE_SUB_DISCOVERY_PORT} は使用中です。何も停止せず終了します。`
    : "Google sub確認用のlocalhost画面を開始できませんでした。");
  process.exitCode = 1;
});

session.server.listen(GOOGLE_SUB_DISCOVERY_PORT, GOOGLE_SUB_DISCOVERY_HOST, () => {
  console.log(`Google sub確認用の一時画面を ${GOOGLE_SUB_DISCOVERY_REDIRECT_URI} で待機しています。`);
  console.log("subはターミナルへ表示せず、localhostのブラウザ画面だけに表示します。");
  const opened = spawnSync("/usr/bin/open", [session.authorizationUrl], { stdio: "ignore" });
  if (opened.status !== 0) {
    console.error("ブラウザを開けませんでした。何も保存せず終了します。");
    session.server.close();
    process.exitCode = 1;
  }
});

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is missing from the gateway personal configuration`);
  return value;
}
