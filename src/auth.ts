import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export type AiClientRecord = { id: string; key_sha256: string; enabled: boolean };

export class ClientAuthenticator {
  readonly clients: AiClientRecord[];
  constructor(clients: AiClientRecord[] = []) {
    this.clients = clients.map((client) => ({ ...client }));
    const ids = new Set<string>();
    for (const client of this.clients) {
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(client.id) || !/^[a-f0-9]{64}$/.test(client.key_sha256) || ids.has(client.id)) throw new Error("AI client key configuration is invalid");
      ids.add(client.id);
    }
  }
  static fromFile(path: string | undefined): ClientAuthenticator {
    if (!path) return new ClientAuthenticator();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; clients?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.clients)) throw new Error("AI client key file is invalid");
    return new ClientAuthenticator(parsed.clients as AiClientRecord[]);
  }
  authenticate(authorization: string | undefined): string | undefined {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]{32,256})$/);
    if (!match) return undefined;
    const digest = createHash("sha256").update(match[1]).digest();
    for (const client of this.clients) {
      if (!client.enabled) continue;
      const expected = Buffer.from(client.key_sha256, "hex");
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) return client.id;
    }
  }
  get configuredClientCount(): number { return this.clients.filter((client) => client.enabled).length; }
}
