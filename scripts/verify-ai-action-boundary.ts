import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const baseUrl = process.argv[2];
const secretPath = process.argv[3] ?? ".runtime/secrets/integration-test.key";
if (!baseUrl?.startsWith("https://")) throw new Error("usage: node scripts/verify-ai-action-boundary.ts <https-origin> [secret-file]");

const secret = readFileSync(secretPath, "utf8").trim();
const auditPath = new URL("../data/actions.jsonl", import.meta.url);
const before = auditLines();
const key = `blocked-boundary-${randomUUID()}`;
const payload = JSON.stringify({ action_id: "automation.scene.execute", parameters: {} });
const common = { "Content-Type": "application/json", "Idempotency-Key": key, "ngrok-skip-browser-warning": "1" };

const unauthorized = await fetch(`${baseUrl}/ai/v1/actions`, {
  method: "POST", headers: common, body: payload, signal: AbortSignal.timeout(15_000),
});
const blocked = await fetch(`${baseUrl}/ai/v1/actions`, {
  method: "POST", headers: { ...common, Authorization: `Bearer ${secret}` }, body: payload, signal: AbortSignal.timeout(15_000),
});
if (unauthorized.status !== 401) throw new Error(`unauthenticated action boundary returned HTTP ${unauthorized.status}`);
if (blocked.status !== 400) throw new Error(`default Policy did not reject the candidate action (HTTP ${blocked.status})`);

const after = auditLines();
if (after.length !== before.length) throw new Error("Catalog-outside request unexpectedly reached Action Core execution logging");
console.log(JSON.stringify({
  unauthenticated_status: unauthorized.status,
  authenticated_catalog_outside_status: blocked.status,
  audit_increment: 0,
  rejected_before_execution: true,
  adapter_reached: false,
  actuation_performed: false,
}, null, 2));

function auditLines(): Array<Record<string, unknown>> {
  try {
    return readFileSync(auditPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
