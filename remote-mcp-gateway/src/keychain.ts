import { spawnSync } from "node:child_process";

export interface SecretStore {
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  delete(account: string): void;
}

export class MacKeychainSecretStore implements SecretStore {
  readonly service: string;
  constructor(service: string) { this.service = service; }
  get(account: string): string | undefined {
    const result = spawnSync("security", ["find-generic-password", "-s", this.service, "-a", account, "-w"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  }
  set(account: string, value: string): void {
    if (!value) throw new Error("refusing to store an empty secret");
    const result = spawnSync("security", ["add-generic-password", "-U", "-s", this.service, "-a", account, "-w", value], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.status !== 0) throw new Error("macOS Keychain write failed");
  }
  delete(account: string): void {
    const result = spawnSync("security", ["delete-generic-password", "-s", this.service, "-a", account], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.status !== 0 && result.status !== 44) throw new Error("macOS Keychain delete failed");
  }
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  get(account: string): string | undefined { return this.values.get(account); }
  set(account: string, value: string): void { this.values.set(account, value); }
  delete(account: string): void { this.values.delete(account); }
}
