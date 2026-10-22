import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  GOOGLE_SUB_DISCOVERY_PATH,
  createGoogleSubDiscoverySession,
} from "../src/google-sub-discovery.ts";

test("Google sub discovery binds to loopback and shows the verified sub only on its one-time local result page", async () => {
  const expectedSub = "verified-local-google-sub";
  const session = createGoogleSubDiscoverySession({
    clientId: "google-client-id-for-tests",
    clientSecret: "not-printed-test-secret",
    redirectUri: "http://127.0.0.1:8795/oauth/google/sub-callback",
    exchangeCode: async (code, nonce, verifier) => {
      assert.equal(code, "one-time-google-code");
      assert.ok(nonce.length >= 32);
      assert.ok(verifier.length >= 43);
      return expectedSub;
    },
  });
  await new Promise<void>((resolve) => session.server.listen(0, "127.0.0.1", resolve));
  const address = session.server.address() as AddressInfo;
  assert.equal(address.address, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  const authorization = new URL(session.authorizationUrl);
  assert.equal(authorization.searchParams.get("scope"), "openid");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");

  const callback = new URL(`${origin}${GOOGLE_SUB_DISCOVERY_PATH}`);
  callback.searchParams.set("code", "one-time-google-code");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  const verified = await fetch(callback, { redirect: "manual" });
  assert.equal(verified.status, 303);
  assert.doesNotMatch(verified.headers.get("location") ?? "", /google-code|sub/);
  const result = await fetch(`${origin}${verified.headers.get("location")}`);
  const html = await result.text();
  assert.equal(result.status, 200);
  assert.match(html, new RegExp(expectedSub));
  assert.match(html, /チャットには貼らない/);
  if (session.server.listening) {
    await new Promise<void>((resolve) => session.server.once("close", resolve));
  }
});
