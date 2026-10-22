import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ClientAuthenticator } from "../src/auth.ts";

test("client keys identify separately and disabled records are individually revoked", () => {
  const keyA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; const keyB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const auth = new ClientAuthenticator([
    { id: "chatgpt", key_sha256: createHash("sha256").update(keyA).digest("hex"), enabled: true },
    { id: "grok", key_sha256: createHash("sha256").update(keyB).digest("hex"), enabled: false },
  ]);
  assert.equal(auth.authenticate(`Bearer ${keyA}`), "chatgpt");
  assert.equal(auth.authenticate(`Bearer ${keyB}`), undefined);
  assert.equal(auth.authenticate("Bearer wrong"), undefined);
  assert.equal(auth.configuredClientCount, 1);
});
