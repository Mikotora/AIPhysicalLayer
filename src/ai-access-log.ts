import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AiAccessLogEntry = {
  timestamp: string;
  client_id: string | null;
  method: string;
  path: string;
  phase: "attempt" | "result";
  status: number | null;
  auth_header: "missing" | "bearer" | "other";
  auth_scheme: "bearer" | "basic" | "other" | null;
  auth_header_length: number | null;
  credential_length: number | null;
};

export interface AiAccessLogWriter {
  append(entry: AiAccessLogEntry): Promise<void>;
}

export class MemoryAiAccessLog implements AiAccessLogWriter {
  readonly entries: AiAccessLogEntry[] = [];

  async append(entry: AiAccessLogEntry): Promise<void> {
    this.entries.push(structuredClone(entry));
  }
}

export class FileAiAccessLog implements AiAccessLogWriter {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(entry: AiAccessLogEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
