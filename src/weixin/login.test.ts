import assert from "node:assert/strict";
import test from "node:test";

import { __loginTestHooks, startLogin, waitLogin } from "./login.ts";

test("releases pending credential when wait API is never called for 3 minutes", async () => {
  let nowMs = 0;

  __loginTestHooks.reset();
  __loginTestHooks.setDependencies({
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    fetchQRCode: async () => ({
      qrcode: "qr-code",
      qrcode_img_content: "https://example.com/qr-code",
    }),
    pollQRStatus: async () => ({ status: "wait" }),
  });

  const first = await startLogin({
    sessionKey: "session-a",
    credential: "demo-bot",
  });

  nowMs += 3 * 60_000 + 1;
  __loginTestHooks.purgeUnusedLogins();

  const waitResult = await waitLogin({
    sessionKey: first.sessionKey,
    timeoutMs: 1_000,
  });

  assert.equal(waitResult.connected, false);
  assert.equal(waitResult.message, "login session not found");

  const second = await startLogin({
    sessionKey: "session-b",
    credential: "demo-bot",
  });

  assert.equal(second.message, "QR code created");
  assert.equal(second.credential, "demo-bot");

  __loginTestHooks.reset();
});

test("keeps pending credential when wait API has been called", async () => {
  let nowMs = 0;

  __loginTestHooks.reset();
  __loginTestHooks.setDependencies({
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    fetchQRCode: async () => ({
      qrcode: "qr-code",
      qrcode_img_content: "https://example.com/qr-code",
    }),
    pollQRStatus: async () => ({ status: "wait" }),
  });

  await startLogin({
    sessionKey: "session-c",
    credential: "demo-bot-2",
  });

  const waitResult = await waitLogin({
    sessionKey: "session-c",
    timeoutMs: 1_000,
  });

  assert.equal(waitResult.connected, false);
  assert.equal(waitResult.message, "login timed out");

  nowMs += 3 * 60_000 + 1;
  __loginTestHooks.purgeUnusedLogins();

  await assert.rejects(
    startLogin({
      sessionKey: "session-d",
      credential: "demo-bot-2",
    }),
    /credential already in pending login: demo-bot-2/,
  );

  __loginTestHooks.reset();
});
