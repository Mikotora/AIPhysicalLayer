import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMcpReadiness } from "../src/mcp-readiness.ts";
import { parseSecureMcpTunnelConfig, tunnelHealthReady, type SecureMcpTunnelConfig } from "../src/secure-tunnel.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNTIME_DIR = join(ROOT, ".runtime");
const LOG_DIR = join(RUNTIME_DIR, "logs");
const STATE_FILE = join(RUNTIME_DIR, "processes.json");
const CONFIG_FILE = join(ROOT, "config", "runtime.json");
const SECRET_ENV_FILE = join(ROOT, ".env.local");
const AI_CLIENT_KEYS_FILE = join(ROOT, "config", "ai-clients.json");
const MCP_CLIENT_ID = "chatgpt-private-plugin";
const MCP_SECRET_FILE = join(RUNTIME_DIR, "secrets", "mcp-private-plugin.key");
const TUNNEL_RUNTIME_SECRET_FILE = join(RUNTIME_DIR, "secrets", "openai-tunnel-runtime.key");
const NODE = process.execPath;

type RuntimeConfig = {
  publicOrigin: string;
  ngrok: { binary: string; upstream: string; apiUrl: string; trafficPolicyFile: string };
  secureMcpTunnel: SecureMcpTunnelConfig;
  remoteMcpGateway: {
    enabled: boolean;
    configFile: string;
    coreTokenFile: string;
    databaseFile: string;
    auditLogFile: string;
  };
};
type ManagedProcess = { pid: number; marker: string; startedAt: string };
type ProcessState = { core?: ManagedProcess; mcp?: ManagedProcess; secureMcpTunnel?: ManagedProcess; remoteMcpGateway?: ManagedProcess; entry?: ManagedProcess; ngrok?: ManagedProcess };
type StatusReport = {
  overall: "ready" | "degraded" | "stopped";
  processes: Record<string, "running" | "stopped" | "unmanaged">;
  checks: Record<string, { status: "ok" | "unavailable" | "disabled"; detail: string }>;
  doorClients: Array<{ client_name_claimed: string; redirect_host: string; status: string; last_used_at: string | null; refresh_expires_at: string | null }>;
  googleMasterSwitch: string;
  actuationPerformed: false;
};

const command = process.argv[2] ?? "status";
const jsonOutput = process.argv.includes("--json");

try {
  if (command === "start") await startAll();
  else if (command === "stop") await stopAll();
  else if (command === "status" || command === "doctor") await printStatus(jsonOutput);
  else if (command === "intent:new") await createIntent();
  else if (command === "door:clients") runDoorAdmin("list");
  else if (command === "door:pending") runDoorAdmin("pending");
  else if (command === "door:approve") runDoorAdmin("approve", process.argv[3]);
  else if (command === "door:reject") runDoorAdmin("reject", process.argv[3]);
  else if (command === "door:revoke") runDoorAdmin("revoke", process.argv[3]);
  else if (command === "door:revoke-all") runDoorAdmin("revoke-all");
  else if (command === "door:google-secret:set") runDoorKeychain("set", "client-secret");
  else if (command === "door:google-secret:exists") runDoorKeychain("exists", "client-secret");
  else if (command === "door:google-refresh:exists") runDoorKeychain("exists", "refresh-token");
  else if (command === "door:google-refresh:delete") runDoorKeychain("delete", "refresh-token");
  else if (command === "door:google-sub") showDoorGoogleSub();
  else if (command === "door:configure") configureDoor();
  else if (command === "door:core-key:create") createDoorCoreKey();
  else if (command === "door:policy:upgrade") upgradeDoorPolicy();
  else if (command === "door:start") await startDoor();
  else if (command === "door:stop") await stopDoor();
  else throw new Error("usage: service.ts start|stop|status|doctor|intent:new|door:clients|door:pending|door:approve <client-id>|door:reject <client-id>|door:revoke <client-id>|door:revoke-all|door:start|door:stop|door:core-key:create|door:google-secret:set|door:google-secret:exists|door:google-refresh:exists|door:google-refresh:delete|door:google-sub|door:configure|door:policy:upgrade [--json]");
} catch (error) {
  console.error(error instanceof Error ? error.message : "service command failed");
  process.exitCode = 1;
}

async function startAll(): Promise<void> {
  const config = readRuntimeConfig();
  validateSecretConfig();
  validateNgrok(config);
  validateSecureMcpTunnel(config);
  validateRemoteMcpGateway(config);
  mkdirSync(LOG_DIR, { recursive: true });
  const existing = readState();
  if (Object.values(existing).some((item) => item && isExpectedProcess(item))) {
    throw new Error("managed services are already running; use status or stop first");
  }
  if (await anyKnownEndpointResponds(config)) {
    throw new Error("a required port is already in use by an unmanaged process; inspect status before starting");
  }

  const state: ProcessState = {};
  try {
    const sharedEnvironment = existsSync(AI_CLIENT_KEYS_FILE) ? { AI_CLIENT_KEYS_FILE } : {};
    state.core = spawnManaged("core", NODE, ["--env-file=.env.local", "src/server.ts"], sharedEnvironment, "src/server.ts");
    writeState(state);
    await waitFor(async () => Boolean(await fetchJson("http://127.0.0.1:8787/api/status")), 10_000, "Core did not become ready");

    if (config.remoteMcpGateway.enabled) {
      state.remoteMcpGateway = spawnManaged("remote-mcp-gateway", NODE, ["remote-mcp-gateway/src/server.ts"], {
        REMOTE_MCP_CONFIG_FILE: config.remoteMcpGateway.configFile,
        REMOTE_MCP_PUBLIC_ORIGIN: config.publicOrigin,
        REMOTE_MCP_CORE_TOKEN_FILE: config.remoteMcpGateway.coreTokenFile,
        REMOTE_MCP_DATABASE_FILE: config.remoteMcpGateway.databaseFile,
        REMOTE_MCP_AUDIT_LOG_FILE: config.remoteMcpGateway.auditLogFile,
      }, "remote-mcp-gateway/src/server.ts");
      writeState(state);
      await waitFor(async () => record(await fetchJson("http://127.0.0.1:8794/health"))?.status === "ok", 10_000, "Remote MCP gateway did not become ready");
    }

    state.mcp = spawnManaged("mcp", NODE, ["src/mcp-server.ts"], {
      MCP_CORE_TOKEN_FILE: MCP_SECRET_FILE,
      MCP_CLIENT_ID,
    }, "src/mcp-server.ts");
    writeState(state);
    await waitFor(async () => Boolean(await fetchJson("http://127.0.0.1:8792/health")), 10_000, "MCP façade did not become ready");

    validateSecureMcpTunnelDoctor(config);
    state.secureMcpTunnel = spawnManaged("secure-mcp-tunnel", config.secureMcpTunnel.binary, [
      "run", "--profile-file", config.secureMcpTunnel.profileFile,
    ], {}, "tunnel-client run");
    writeState(state);
    await waitFor(async () => tunnelHealthReady(
      await fetchText(config.secureMcpTunnel.healthUrl + "/healthz"),
      await fetchText(config.secureMcpTunnel.healthUrl + "/readyz"),
    ), 30_000, "Secure MCP Tunnel did not become ready");

    await verifyMcpReadiness("http://127.0.0.1:8792/mcp", readFileSync(MCP_SECRET_FILE, "utf8").trim());

    state.entry = spawnManaged("entry", NODE, ["src/off-entry.ts"], {
      OFF_ENTRY_PUBLIC_ORIGIN: config.publicOrigin,
      ...(config.remoteMcpGateway.enabled ? { REMOTE_MCP_GATEWAY_ORIGIN: "http://127.0.0.1:8794" } : {}),
      ...sharedEnvironment,
    }, "src/off-entry.ts");
    writeState(state);
    await waitFor(async () => Boolean(await fetchJson("http://127.0.0.1:8790/health")), 10_000, "OFF entry did not become ready");
    await waitFor(async () => Boolean(await fetchJson("http://127.0.0.1:8791/health")), 10_000, "Intent control did not become ready");

    state.ngrok = spawnManaged("ngrok", config.ngrok.binary, [
      "http", config.ngrok.upstream,
      "--url", config.publicOrigin,
      "--traffic-policy-file", config.ngrok.trafficPolicyFile,
      "--inspect=false", "--log=stdout", "--log-format=json",
    ], {}, "ngrok http");
    writeState(state);
    await waitFor(async () => tunnelMatches(await fetchJson(config.ngrok.apiUrl + "/api/tunnels"), config), 15_000, "ngrok tunnel did not become ready");
  } catch (error) {
    await stopState(state);
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    throw error;
  }

  console.log(`AIPhysicalLayer started: Core, MCP façade, Secure MCP Tunnel, OFF entry, intent control, authenticated ngrok tunnel${config.remoteMcpGateway.enabled ? ", and Remote MCP common gateway" : ""}`);
  await printStatus(false);
}

async function stopAll(): Promise<void> {
  await stopState(readState());
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  console.log("AIPhysicalLayer stopped");
}

async function stopState(state: ProcessState): Promise<void> {
  for (const item of [state.ngrok, state.entry, state.secureMcpTunnel, state.mcp, state.remoteMcpGateway, state.core]) {
    if (!item || !isExpectedProcess(item)) continue;
    try { process.kill(item.pid, "SIGTERM"); } catch { continue; }
    const exited = await waitUntilStopped(item.pid, 4_000);
    if (!exited && isExpectedProcess(item)) {
      try { process.kill(item.pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  }
}

async function printStatus(asJson: boolean): Promise<void> {
  const report = await collectStatus();
  if (asJson) return void console.log(JSON.stringify(report, null, 2));
  console.log(`AIPhysicalLayer: ${report.overall}`);
  for (const [name, state] of Object.entries(report.processes)) console.log(`  process ${name}: ${state}`);
  for (const [name, check] of Object.entries(report.checks)) console.log(`  ${name}: ${check.status} - ${check.detail}`);
  if (report.doorClients.length > 0) {
    console.log("  clients:");
    for (const client of report.doorClients) console.log(`    ${client.client_name_claimed} (self-claimed) redirect=${client.redirect_host} status=${client.status} last_used=${client.last_used_at ?? "-"} refresh_expires=${client.refresh_expires_at ?? "-"}`);
  }
  console.log(`  google master switch: ${report.googleMasterSwitch}`);
  console.log("  device operation during status: none");
}

async function collectStatus(): Promise<StatusReport> {
  let config: RuntimeConfig | undefined;
  let configDetail = "runtime configuration is valid";
  try {
    config = readRuntimeConfig();
    validateSecretConfig();
    validateNgrok(config);
    validateSecureMcpTunnel(config);
    validateRemoteMcpGateway(config);
  } catch (error) {
    config = undefined;
    configDetail = error instanceof Error ? error.message : "invalid runtime configuration";
  }
  const state = readState();
  const apiUrl = config?.ngrok.apiUrl ?? "http://127.0.0.1:4040";
  const processes = {
    core: processState(state.core, "http://127.0.0.1:8787/api/status"),
    mcp: processState(state.mcp, "http://127.0.0.1:8792/health"),
    secureMcpTunnel: processState(state.secureMcpTunnel, (config?.secureMcpTunnel.healthUrl ?? "http://127.0.0.1:8793") + "/readyz"),
    remoteMcpGateway: processStateAnyStatus(state.remoteMcpGateway, "http://127.0.0.1:8794/health"),
    entry: processState(state.entry, "http://127.0.0.1:8790/health"),
    ngrok: processState(state.ngrok, apiUrl + "/api/tunnels"),
  } as StatusReport["processes"];
  const [core, mcp, secureTunnelHealth, secureTunnelReady, door, entry, control, tunnels] = await Promise.all([
    fetchJson("http://127.0.0.1:8787/api/health"),
    fetchJson("http://127.0.0.1:8792/health"),
    fetchText((config?.secureMcpTunnel.healthUrl ?? "http://127.0.0.1:8793") + "/healthz"),
    fetchText((config?.secureMcpTunnel.healthUrl ?? "http://127.0.0.1:8793") + "/readyz"),
    fetchJson("http://127.0.0.1:8794/health"),
    fetchJson("http://127.0.0.1:8790/health"),
    fetchJson("http://127.0.0.1:8791/health"),
    fetchJson(apiUrl + "/api/tunnels"),
  ]);
  const coreRecord = record(core);
  const adapter = record(coreRecord?.adapter);
  const natureOk = coreRecord?.mode === "nature" && adapter?.adapter === "nature" && adapter?.status === "ok";
  const secureTunnelOk = tunnelHealthReady(secureTunnelHealth, secureTunnelReady);
  const doorRecord = record(door);
  const doorClients = Array.isArray(doorRecord?.clients) ? doorRecord.clients.map(record).filter(Boolean).map((client) => ({
    client_name_claimed: typeof client!.client_name_claimed === "string" ? client!.client_name_claimed : "unknown",
    redirect_host: typeof client!.redirect_host === "string" ? client!.redirect_host : "unknown",
    status: typeof client!.status === "string" ? client!.status : "unknown",
    last_used_at: typeof client!.last_used_at === "string" ? client!.last_used_at : null,
    refresh_expires_at: typeof client!.refresh_expires_at === "string" ? client!.refresh_expires_at : null,
  })) : [];
  let pluginReadiness: Awaited<ReturnType<typeof verifyMcpReadiness>> | undefined;
  if (mcp && secureTunnelOk && existsSync(MCP_SECRET_FILE)) {
    try {
      pluginReadiness = await verifyMcpReadiness("http://127.0.0.1:8792/mcp", readFileSync(MCP_SECRET_FILE, "utf8").trim());
    } catch { /* reported as unavailable without exposing response or credentials */ }
  }
  const checks: StatusReport["checks"] = {
    config: { status: config ? "ok" : "unavailable", detail: configDetail },
    core: { status: core ? "ok" : "unavailable", detail: core ? "Core is responding on localhost" : "Core is not responding" },
    mcp: { status: mcp ? "ok" : "unavailable", detail: mcp ? "Streamable HTTP MCP is responding on localhost:8792" : "MCP façade is not responding" },
    secureMcpTunnel: {
      status: secureTunnelOk ? "ok" : "unavailable",
      detail: secureTunnelOk ? "Secure MCP Tunnel is connected and polling over outbound HTTPS" : "Secure MCP Tunnel is not ready",
    },
    door: {
      status: config?.remoteMcpGateway.enabled
        ? (doorRecord?.status === "ok" ? "ok" : "unavailable")
        : processes.remoteMcpGateway === "stopped" ? "disabled" : "unavailable",
      detail: config?.remoteMcpGateway.enabled
        ? doorRecord?.status === "ok" ? "Remote MCP common gateway is responding on localhost:8794" : "Remote MCP common gateway is not ready"
        : processes.remoteMcpGateway === "stopped" ? "Remote MCP common gateway is not enabled in runtime configuration" : "An unexpected Remote MCP gateway process is responding",
    },
    plugin: {
      status: pluginReadiness ? "ok" : "unavailable",
      detail: pluginReadiness
        ? `Plugin path is ready: Capability ${pluginReadiness.deviceCount} devices, State ${pluginReadiness.stateCount} devices/${pluginReadiness.perceptionCount} perceptions, Action tool available`
        : "Plugin path is not ready for Capability, State, and Action",
    },
    entry: { status: entry ? "ok" : "unavailable", detail: entry ? "OFF entry is responding on localhost" : "OFF entry is not responding" },
    intentControl: { status: control ? "ok" : "unavailable", detail: control ? "Intent control is local and responding" : "Intent control is not responding" },
    ngrok: {
      status: config && tunnelMatches(tunnels, config) ? "ok" : "unavailable",
      detail: config && tunnelMatches(tunnels, config) ? "Authenticated tunnel is connected to 127.0.0.1:8790" : "Expected tunnel is not connected",
    },
    ngrokUsage: {
      status: "disabled",
      detail: "Monthly request usage is not exposed by the local ngrok agent API",
    },
    nature: {
      status: natureOk ? "ok" : "unavailable",
      detail: natureOk && typeof adapter?.detail === "string"
        ? adapter.detail
        : coreRecord?.mode !== "nature"
          ? "Core is not running in Nature mode"
          : "Nature read-only health check is unavailable",
    },
  };
  const ok = Object.values(checks).every((check) => check.status === "ok" || check.status === "disabled");
  const anyRunning = Object.values(processes).some((value) => value !== "stopped");
  return {
    overall: ok ? "ready" : anyRunning ? "degraded" : "stopped", processes, checks, doorClients,
    googleMasterSwitch: typeof doorRecord?.google_master_switch?.value === "string" ? doorRecord.google_master_switch.value : "unknown",
    actuationPerformed: false,
  };
}

async function createIntent(): Promise<void> {
  const response = await fetch("http://127.0.0.1:8791/intents", { method: "POST", headers: { "X-Intent-Request": "new-light-off" } }).catch(() => undefined);
  if (!response) throw new Error("intent control is not reachable");
  if (!response.ok) throw new Error(response.status === 409 ? "current intent has not completed" : "intent issuance failed");
  const body = record(await response.json());
  console.log(`new intent ready: ${typeof body?.request_id === "string" ? body.request_id : "issued"}`);
  console.log("device operation performed: none");
}

function readRuntimeConfig(): RuntimeConfig {
  const value = record(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
  const ngrok = record(value?.ngrok);
  if (!value || typeof value.publicOrigin !== "string" || !ngrok) throw new Error("config/runtime.json is invalid");
  const remoteMcpGateway = record(value.remoteMcpGateway);
  const remoteEnabled = remoteMcpGateway?.enabled === true;
  if (remoteMcpGateway && typeof remoteMcpGateway.enabled !== "boolean") throw new Error("remoteMcpGateway.enabled must be boolean");
  if (remoteEnabled && ["configFile", "coreTokenFile", "databaseFile", "auditLogFile"].some((name) => typeof remoteMcpGateway?.[name] !== "string")) {
    throw new Error("remote MCP gateway runtime configuration is incomplete");
  }
  const origin = new URL(value.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== value.publicOrigin) throw new Error("publicOrigin must be one exact HTTPS origin");
  if (typeof ngrok.binary !== "string" || typeof ngrok.upstream !== "string" || typeof ngrok.apiUrl !== "string" || typeof ngrok.trafficPolicyFile !== "string") throw new Error("ngrok runtime configuration is incomplete");
  if (ngrok.upstream !== "http://127.0.0.1:8790") throw new Error("ngrok upstream must remain http://127.0.0.1:8790");
  return {
    publicOrigin: value.publicOrigin,
    ngrok: ngrok as RuntimeConfig["ngrok"],
    secureMcpTunnel: parseSecureMcpTunnelConfig(value.secureMcpTunnel, ROOT),
    remoteMcpGateway: {
      enabled: remoteEnabled,
      configFile: resolve(ROOT, String(remoteMcpGateway?.configFile ?? "remote-mcp-gateway/config/remote-mcp-gateway.json")),
      coreTokenFile: resolve(ROOT, String(remoteMcpGateway?.coreTokenFile ?? ".runtime/secrets/remote-mcp-gateway.key")),
      databaseFile: resolve(ROOT, String(remoteMcpGateway?.databaseFile ?? "data/remote-mcp-gateway.sqlite")),
      auditLogFile: resolve(ROOT, String(remoteMcpGateway?.auditLogFile ?? "data/remote-mcp-access.jsonl")),
    },
  };
}

function validateSecretConfig(): void {
  if (!existsSync(SECRET_ENV_FILE)) throw new Error(".env.local is missing");
  if (!existsSync(MCP_SECRET_FILE)) throw new Error("MCP private-plugin client key is missing");
  const values = new Map<string, string>();
  for (const line of readFileSync(SECRET_ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  const required = ["ADAPTER_MODE", "NATURE_ACCESS_TOKEN", "NATURE_BINDINGS_FILE"];
  const missing = required.filter((name) => !values.get(name));
  if (missing.length > 0) throw new Error(`.env.local is missing required names: ${missing.join(", ")}`);
  if (values.get("ADAPTER_MODE") !== "nature") throw new Error("ADAPTER_MODE must be nature for managed daily operation");
  const bindingFile = values.get("NATURE_BINDINGS_FILE")!;
  if (!existsSync(join(ROOT, bindingFile))) throw new Error("Nature binding configuration is missing");
}

function validateNgrok(config: RuntimeConfig): void {
  if (!existsSync(config.ngrok.trafficPolicyFile)) throw new Error("ngrok traffic policy file is missing");
  if (spawnSync(config.ngrok.binary, ["version"], { stdio: "ignore" }).status !== 0) throw new Error("ngrok executable is unavailable");
}

function validateSecureMcpTunnel(config: RuntimeConfig): void {
  if (!existsSync(config.secureMcpTunnel.binary)) throw new Error("Secure MCP Tunnel client is missing");
  if (!existsSync(config.secureMcpTunnel.profileFile)) throw new Error("Secure MCP Tunnel profile is missing");
  if (!existsSync(TUNNEL_RUNTIME_SECRET_FILE)) throw new Error("Secure MCP Tunnel runtime key is missing");
  if ((statSync(config.secureMcpTunnel.profileFile).mode & 0o777) !== 0o600) throw new Error("Secure MCP Tunnel profile must use mode 0600");
  if ((statSync(TUNNEL_RUNTIME_SECRET_FILE).mode & 0o777) !== 0o600) throw new Error("Secure MCP Tunnel runtime key must use mode 0600");
  if (spawnSync(config.secureMcpTunnel.binary, ["--help"], { stdio: "ignore" }).status !== 0) throw new Error("Secure MCP Tunnel client is unavailable");
  const profile = readFileSync(config.secureMcpTunnel.profileFile, "utf8");
  if (/\bsk-[A-Za-z0-9_-]{20,}/.test(profile)) throw new Error("Secure MCP Tunnel profile must reference its key by file");
  if (!profile.includes("http://127.0.0.1:8792/mcp")) throw new Error("Secure MCP Tunnel target must remain localhost:8792/mcp");
}

function validateSecureMcpTunnelDoctor(config: RuntimeConfig): void {
  const result = spawnSync(config.secureMcpTunnel.binary, [
    "doctor", "--profile-file", config.secureMcpTunnel.profileFile, "--explain",
  ], { cwd: ROOT, stdio: "ignore", timeout: 30_000 });
  if (result.status !== 0) throw new Error("Secure MCP Tunnel profile diagnosis failed");
}

function validateRemoteMcpGateway(config: RuntimeConfig): void {
  if (!config.remoteMcpGateway.enabled) return;
  if (!existsSync(config.remoteMcpGateway.configFile)) throw new Error("remote MCP gateway personal configuration is missing");
  if ((statSync(config.remoteMcpGateway.configFile).mode & 0o077) !== 0) throw new Error("remote MCP gateway personal configuration must not be group/world accessible");
  if (!existsSync(config.remoteMcpGateway.coreTokenFile)) throw new Error("remote MCP gateway Core identity key is missing");
  if ((statSync(config.remoteMcpGateway.coreTokenFile).mode & 0o777) !== 0o600) throw new Error("remote MCP gateway Core identity key must use mode 0600");
  if (!existsSync(join(ROOT, "remote-mcp-gateway", "node_modules", "@modelcontextprotocol", "server"))) throw new Error("remote MCP gateway dependencies are not installed");
}

function spawnManaged(name: string, executable: string, args: string[], env: Record<string, string>, marker: string): ManagedProcess {
  const fd = openSync(join(LOG_DIR, `${name}.log`), "a");
  try {
    const child = spawn(executable, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...env } });
    child.unref();
    if (!child.pid) throw new Error(`${name} could not start`);
    return { pid: child.pid, marker, startedAt: new Date().toISOString() };
  } finally { closeSync(fd); }
}

function readState(): ProcessState {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as ProcessState; } catch { return {}; }
}
function writeState(state: ProcessState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function isExpectedProcess(item: ManagedProcess): boolean {
  if (!Number.isInteger(item.pid) || item.pid < 2) return false;
  try { process.kill(item.pid, 0); } catch { return false; }
  const result = spawnSync("ps", ["-p", String(item.pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes(item.marker);
}

function processState(item: ManagedProcess | undefined, endpoint: string): "running" | "stopped" | "unmanaged" {
  if (item && isExpectedProcess(item)) return "running";
  return spawnSync("curl", ["-fsS", "--max-time", "1", endpoint], { stdio: "ignore" }).status === 0 ? "unmanaged" : "stopped";
}

function processStateAnyStatus(item: ManagedProcess | undefined, endpoint: string): "running" | "stopped" | "unmanaged" {
  if (item && isExpectedProcess(item)) return "running";
  return spawnSync("curl", ["-sS", "--max-time", "1", "-o", "/dev/null", endpoint], { stdio: "ignore" }).status === 0 ? "unmanaged" : "stopped";
}

async function anyKnownEndpointResponds(config: RuntimeConfig): Promise<boolean> {
  const results = await Promise.all([
    fetchJson("http://127.0.0.1:8787/api/status"), fetchJson("http://127.0.0.1:8790/health"),
    fetchJson("http://127.0.0.1:8791/health"), fetchJson("http://127.0.0.1:8792/health"),
    ...(config.remoteMcpGateway.enabled ? [fetchJson("http://127.0.0.1:8794/health")] : []),
    fetchJson(config.ngrok.apiUrl + "/api/tunnels"),
    fetchText(config.secureMcpTunnel.healthUrl + "/readyz"),
  ]);
  return results.some(Boolean);
}

async function fetchJson(url: string): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    return await response.json();
  } catch { return undefined; }
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return undefined;
    return await response.text();
  } catch { return undefined; }
}

function tunnelMatches(value: unknown, config: RuntimeConfig): boolean {
  const tunnels = record(value)?.tunnels;
  if (!Array.isArray(tunnels)) return false;
  return tunnels.some((item) => {
    const tunnel = record(item);
    const tunnelConfig = record(tunnel?.config);
    return tunnel?.public_url === config.publicOrigin && tunnelConfig?.addr === config.ngrok.upstream;
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

async function waitUntilStopped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function runDoorAdmin(action: "list" | "pending" | "approve" | "reject" | "revoke" | "revoke-all", clientId?: string): void {
  const config = readRuntimeConfig();
  if (!config.remoteMcpGateway.enabled) throw new Error("remote MCP gateway is not enabled");
  if (["approve", "reject", "revoke"].includes(action) && !clientId) throw new Error(`usage: ./bin/aipl door:${action} <client-id>`);
  const personalConfig = record(JSON.parse(readFileSync(config.remoteMcpGateway.configFile, "utf8")));
  const result = spawnSync(NODE, ["remote-mcp-gateway/scripts/admin.ts", action, ...(clientId ? [clientId] : [])], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      REMOTE_MCP_DATABASE_FILE: config.remoteMcpGateway.databaseFile,
      REMOTE_MCP_AUDIT_LOG_FILE: config.remoteMcpGateway.auditLogFile,
      REMOTE_MCP_PENDING_CLIENT_TTL_SECONDS: String(personalConfig?.pendingClientTtlSeconds ?? 3600),
    },
  });
  if (result.status !== 0) throw new Error("remote MCP gateway administration failed");
}

function runDoorKeychain(action: "set" | "delete" | "exists", kind: "client-secret" | "refresh-token"): void {
  const config = readRuntimeConfig();
  if (!existsSync(config.remoteMcpGateway.configFile)) throw new Error("remote MCP gateway personal configuration is missing");
  const personalConfig = record(JSON.parse(readFileSync(config.remoteMcpGateway.configFile, "utf8")));
  const service = personalConfig?.keychainService;
  const account = kind === "client-secret" ? personalConfig?.googleClientSecretAccount : personalConfig?.googleRefreshTokenAccount;
  if (typeof service !== "string" || typeof account !== "string") throw new Error("remote MCP gateway Keychain configuration is incomplete");
  const result = spawnSync(NODE, ["remote-mcp-gateway/scripts/keychain-secret.ts", action, service, account], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error("macOS Keychain operation failed");
}

function showDoorGoogleSub(): void {
  const config = readRuntimeConfig();
  if (!existsSync(config.remoteMcpGateway.configFile)) throw new Error("remote MCP gateway personal configuration is missing");
  const result = spawnSync(NODE, ["remote-mcp-gateway/scripts/discover-google-sub.ts", config.remoteMcpGateway.configFile], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Google sub discovery did not complete");
}

function configureDoor(): void {
  const config = readRuntimeConfig();
  if (!existsSync(config.remoteMcpGateway.configFile)) throw new Error("remote MCP gateway personal configuration is missing");
  const result = spawnSync(NODE, [
    "remote-mcp-gateway/scripts/configure.ts",
    config.remoteMcpGateway.configFile,
    CONFIG_FILE,
    join(RUNTIME_DIR, "backups"),
  ], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0 && result.status !== 2) throw new Error("remote MCP gateway configuration failed");
}

function createDoorCoreKey(): void {
  const config = readRuntimeConfig();
  const result = spawnSync(NODE, ["scripts/client-key.ts", "create", "remote-mcp-gateway", "config/ai-clients.json", "--secret-file", config.remoteMcpGateway.coreTokenFile], {
    cwd: ROOT, stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("remote MCP gateway Core identity was not created");
}

function upgradeDoorPolicy(): void {
  const config = readRuntimeConfig();
  const result = spawnSync(NODE, ["scripts/upgrade-ngrok-policy.ts", config.ngrok.trafficPolicyFile], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error("ngrok policy was not changed");
}

async function stopDoor(): Promise<void> {
  const state = readState();
  const item = state.remoteMcpGateway;
  if (!item || !isExpectedProcess(item)) {
    if (processStateAnyStatus(undefined, "http://127.0.0.1:8794/health") === "unmanaged") throw new Error("remote MCP gateway is unmanaged; no process was stopped");
    console.log("Remote MCP common gateway is already stopped");
    return;
  }
  try { process.kill(item.pid, "SIGTERM"); } catch { /* already stopped */ }
  const exited = await waitUntilStopped(item.pid, 4_000);
  if (!exited && isExpectedProcess(item)) throw new Error("remote MCP gateway did not stop; no forced kill was sent");
  delete state.remoteMcpGateway;
  writeState(state);
  console.log("Remote MCP common gateway stopped; existing Core, 8790, 8792, tunnels, and ngrok were not stopped");
}

async function startDoor(): Promise<void> {
  const config = readRuntimeConfig();
  validateRemoteMcpGateway(config);
  if (!config.remoteMcpGateway.enabled) throw new Error("remote MCP gateway is not enabled");
  const state = readState();
  if (state.remoteMcpGateway && isExpectedProcess(state.remoteMcpGateway)) throw new Error("remote MCP gateway is already managed and running");
  if (processStateAnyStatus(undefined, "http://127.0.0.1:8794/health") === "unmanaged") throw new Error("localhost:8794 is already used by an unmanaged process");
  if (!await fetchJson("http://127.0.0.1:8787/api/status")) throw new Error("Core must be running before the Remote MCP gateway starts");
  mkdirSync(LOG_DIR, { recursive: true });
  const item = spawnManaged("remote-mcp-gateway", NODE, ["remote-mcp-gateway/src/server.ts"], {
    REMOTE_MCP_CONFIG_FILE: config.remoteMcpGateway.configFile,
    REMOTE_MCP_PUBLIC_ORIGIN: config.publicOrigin,
    REMOTE_MCP_CORE_TOKEN_FILE: config.remoteMcpGateway.coreTokenFile,
    REMOTE_MCP_DATABASE_FILE: config.remoteMcpGateway.databaseFile,
    REMOTE_MCP_AUDIT_LOG_FILE: config.remoteMcpGateway.auditLogFile,
  }, "remote-mcp-gateway/src/server.ts");
  state.remoteMcpGateway = item; writeState(state);
  try {
    await waitFor(async () => record(await fetchJson("http://127.0.0.1:8794/health"))?.status === "ok", 10_000, "Remote MCP gateway did not become ready");
  } catch (error) {
    try { process.kill(item.pid, "SIGTERM"); } catch { /* already stopped */ }
    delete state.remoteMcpGateway; writeState(state); throw error;
  }
  console.log("Remote MCP common gateway started; no other service or device was operated");
}
