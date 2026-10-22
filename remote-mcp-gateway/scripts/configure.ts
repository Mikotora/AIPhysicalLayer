import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { MacKeychainSecretStore } from "../src/keychain.ts";
import {
  GOOGLE_SUB_DISCOVERY_HOST,
  GOOGLE_SUB_DISCOVERY_PORT,
  GOOGLE_SUB_DISCOVERY_REDIRECT_URI,
  createGoogleSubDiscoverySession,
} from "../src/google-sub-discovery.ts";
import { backupAndWriteDoorConfiguration, prepareDoorConfiguration } from "../src/configuration-writer.ts";

const [gatewayPath, runtimePath, backupDirectory] = process.argv.slice(2);
if (!gatewayPath || !runtimePath || !backupDirectory) throw new Error("gateway, runtime, and backup paths are required");
if (!stdin.isTTY || !stdout.isTTY) throw new Error("door:configure must be run interactively in a terminal");

const gateway = object(JSON.parse(readFileSync(gatewayPath, "utf8")), "remote-mcp-gateway.json");
const runtime = object(JSON.parse(readFileSync(runtimePath, "utf8")), "runtime.json");
const currentClientId = configuredIdentifier(gateway.googleClientId);
const currentSub = configuredIdentifier(gateway.allowedGoogleSub);
const currentBlock = optionalObject(runtime.remoteMcpGateway);
const currentEnabled = currentBlock?.enabled === true;
let hideTerminalInput = false;
const terminalOutput = new Writable({
  write(chunk, _encoding, callback) {
    if (!hideTerminalInput) stdout.write(chunk);
    callback();
  },
});
const readline = createInterface({ input: stdin, output: terminalOutput, terminal: true });

try {
  console.log("共通玄関の個人設定を対話形式で更新します。入力値そのものは確認表示しません。");
  const enteredClientId = (await readline.question(`Google OAuth client ID${currentClientId ? "（空Enterで現在値を維持）" : ""}: `)).trim();
  const googleClientId = enteredClientId || currentClientId;
  if (!googleClientId) throw new Error("Google OAuth client ID is required");

  const shouldDiscover = await yesNo(readline, "Googleログインで sub をlocalhost画面に表示しますか？", !currentSub);
  if (shouldDiscover) await showSubInLocalBrowser(gateway, googleClientId);

  const enteredSub = await hiddenQuestion(readline, `Google sub${currentSub ? "（空Enterで現在値を維持）" : ""}: `);
  const allowedGoogleSub = enteredSub || currentSub;
  if (!allowedGoogleSub) throw new Error("Google sub is required");
  const enabled = await yesNo(readline, "remoteMcpGateway.enabled を true にしますか？", currentEnabled);

  const prepared = prepareDoorConfiguration(gateway, runtime, { googleClientId, allowedGoogleSub, enabled });
  console.log("\n書き込み予定:");
  console.log("- client ID: 入力済み（値は非表示）");
  console.log("- Google sub: 入力済み（値は非表示）");
  console.log(`- remoteMcpGateway block: ${currentBlock ? "更新" : "追加"}`);
  console.log(`- enabled: ${enabled ? "true" : "false"}`);
  console.log("- 書き込み前に .runtime/backups/ へ2ファイルを退避");
  if (!await yesNo(readline, "この内容で書き込みますか？", false)) {
    console.log("キャンセルしました。ファイルは変更していません。");
    process.exitCode = 2;
  } else {
    const backups = backupAndWriteDoorConfiguration(gatewayPath, runtimePath, backupDirectory, prepared);
    console.log("設定を書き込みました。入力値は表示していません。");
    console.log(`backup: ${backups.gatewayBackup}`);
    console.log(`backup: ${backups.runtimeBackup}`);
    console.log("サービスの起動・停止や家電操作は行っていません。");
  }
} finally {
  readline.close();
}

async function showSubInLocalBrowser(config: Record<string, unknown>, clientId: string): Promise<void> {
  const keychainService = required(config.keychainService, "keychainService");
  const secretAccount = required(config.googleClientSecretAccount, "googleClientSecretAccount");
  const clientSecret = new MacKeychainSecretStore(keychainService).get(secretAccount);
  if (!clientSecret) throw new Error("Google OAuth client secret is missing from macOS Keychain");
  const session = createGoogleSubDiscoverySession({ clientId, clientSecret });
  const listening = new Promise<void>((resolve, reject) => {
    session.server.once("error", reject);
    session.server.listen(GOOGLE_SUB_DISCOVERY_PORT, GOOGLE_SUB_DISCOVERY_HOST, resolve);
  });
  try { await listening; }
  catch (error) {
    throw new Error(error instanceof Error && "code" in error && error.code === "EADDRINUSE"
      ? `localhost:${GOOGLE_SUB_DISCOVERY_PORT} is already in use; nothing was stopped`
      : "Google sub discovery localhost page could not start");
  }
  console.log(`sub確認用の一時画面を ${GOOGLE_SUB_DISCOVERY_REDIRECT_URI} で待機しています。`);
  console.log("ブラウザでGoogleログインし、表示されたsubをコピーしてください。ターミナルには表示しません。");
  if (spawnSync("/usr/bin/open", [session.authorizationUrl], { stdio: "ignore" }).status !== 0) {
    session.server.close();
    throw new Error("browser could not be opened; no value was saved");
  }
  let expired = false;
  const timeout = setTimeout(() => { expired = true; session.server.close(); }, 5 * 60 * 1_000);
  await once(session.server, "close");
  clearTimeout(timeout);
  if (expired) throw new Error("Google sub discovery expired after five minutes; no value was saved");
}

async function hiddenQuestion(readlineInterface: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  stdout.write(prompt);
  hideTerminalInput = true;
  try { return (await readlineInterface.question("")).trim(); }
  finally { hideTerminalInput = false; stdout.write("\n"); }
}

async function yesNo(readlineInterface: ReturnType<typeof createInterface>, prompt: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n]: " : " [y/N]: ";
  const answer = (await readlineInterface.question(prompt + suffix)).trim().toLowerCase();
  if (!answer) return defaultValue;
  if (answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  throw new Error("yes/noで入力してください");
}

function configuredIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 6 && !value.startsWith("replace-with-") ? value : undefined;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must contain one JSON object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is missing from remote-mcp-gateway.json`);
  return value;
}
