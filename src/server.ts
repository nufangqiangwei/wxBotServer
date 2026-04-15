import http from "node:http";

import { loadConfig } from "./config.ts";
import {
  listAccounts,
  requireAccount,
  requireAccountByCredential,
  type AccountRecord,
} from "./storage/accounts.ts";
import {
  consumePendingMessages,
  getAccountSessionState,
  getStoredContextToken,
  getStoredUpdatesCursor,
  listConversationHistory,
  recordIncomingMessages,
  recordOutgoingMessages,
  requireConversation,
  saveUpdatesCursor,
} from "./storage/session-state.ts";
import { getConfig, getUpdates, getUploadUrl, sendTyping } from "./weixin/api.ts";
import { startLogin, waitLogin } from "./weixin/login.ts";
import { sendMediaMessage, sendTextMessage } from "./weixin/messages.ts";
import { logger } from "./utils/logger.ts";
import { logIncomingRequest, readJsonBody, sendJson } from "./utils/http.ts";

const appConfig = loadConfig();
const API_VERSION_PREFIX = /^\/api\/v(?:1|2)(?=\/|$)/;
const V2_API_PREFIX = /^\/api\/v2(?=\/|$)/;
const V1_API_PREFIX = /^\/api\/v1(?=\/|$)/;
const LEGACY_API_PREFIX = /^\/api(?=\/|$)/;
const V2_UPDATE_DRAIN_TIMEOUT_MS = 100;
const V2_UPDATE_DRAIN_LIMIT = 20;

type ApiVersion = "legacy" | "v1" | "v2" | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing required string field: ${key}`);
  }
  return value.trim();
}

function getOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getOptionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detectApiVersion(pathname: string): ApiVersion {
  if (V2_API_PREFIX.test(pathname)) return "v2";
  if (V1_API_PREFIX.test(pathname)) return "v1";
  if (LEGACY_API_PREFIX.test(pathname)) return "legacy";
  return null;
}

function normalizeApiPath(pathname: string): string {
  if (!API_VERSION_PREFIX.test(pathname)) {
    return pathname;
  }
  return pathname.replace(API_VERSION_PREFIX, "/api");
}

function buildAccountOpts(account: AccountRecord): { baseUrl: string; token: string } {
  return {
    baseUrl: account.baseUrl,
    token: account.botToken,
  };
}

function getAccountContext(body: Record<string, unknown>) {
  const accountId = getRequiredString(body, "accountId");
  const account = requireAccount(accountId);
  return {
    account,
    opts: buildAccountOpts(account),
  };
}

function getCredentialValue(body: Record<string, unknown>): string | undefined {
  return getOptionalString(body, "credential") || getOptionalString(body, "name");
}

function getRequiredCredential(body: Record<string, unknown>): string {
  const credential = getCredentialValue(body);
  if (!credential) {
    throw new Error("missing required string field: credential");
  }
  return credential;
}

function getCredentialQuery(url: URL): string {
  const credential = url.searchParams.get("credential")?.trim();
  if (!credential) {
    throw new Error("missing required query param: credential");
  }
  return credential;
}

function getCredentialContext(credential: string) {
  const account = requireAccountByCredential(credential);
  return {
    credential,
    account,
    opts: buildAccountOpts(account),
  };
}

function getV2AccountContext(body: Record<string, unknown>) {
  return getCredentialContext(getRequiredCredential(body));
}

function getConversationContext(account: AccountRecord, conversationId: string) {
  const conversation = requireConversation(account.accountId, conversationId);
  const contextToken =
    conversation.lastContextToken ||
    getStoredContextToken(account.accountId, conversation.peerUserId);
  return {
    conversation,
    contextToken,
  };
}

async function collectV2Updates(params: {
  account: AccountRecord;
  timeoutMs?: number;
}) {
  const initialCursor = getStoredUpdatesCursor(params.account.accountId);
  let cursor = initialCursor;
  let requestTimeoutMs = params.timeoutMs;

  for (let round = 0; round < V2_UPDATE_DRAIN_LIMIT; round += 1) {
    const result = await getUpdates({
      ...buildAccountOpts(params.account),
      baseUrl: params.account.baseUrl,
      get_updates_buf: cursor,
      timeoutMs: requestTimeoutMs,
    });

    if (typeof result.get_updates_buf === "string") {
      cursor = result.get_updates_buf;
    }

    recordIncomingMessages({
      accountId: params.account.accountId,
      accountUserId: params.account.userId,
      messages: result.msgs ?? [],
    });

    if (!(result.msgs ?? []).length) {
      break;
    }
    requestTimeoutMs = V2_UPDATE_DRAIN_TIMEOUT_MS;
  }

  if (cursor !== initialCursor) {
    saveUpdatesCursor(params.account.accountId, cursor);
  }

  return consumePendingMessages(params.account.accountId);
}

async function handleV2Get(
  pathname: string,
  url: URL,
  res: http.ServerResponse,
): Promise<boolean> {
  if (pathname === "/api/accounts") {
    sendJson(res, 200, {
      ok: true,
      accounts: listAccounts().filter((account) => account.credential),
    });
    return true;
  }

  if (pathname === "/api/state") {
    const credential = getCredentialQuery(url);
    const { account } = getCredentialContext(credential);
    sendJson(res, 200, {
      ok: true,
      credential,
      accountId: account.accountId,
      state: getAccountSessionState(account.accountId),
    });
    return true;
  }

  if (pathname === "/api/messages/history") {
    const credential = getCredentialQuery(url);
    const { account } = getCredentialContext(credential);
    sendJson(res, 200, {
      ok: true,
      credential,
      accountId: account.accountId,
      conversations: listConversationHistory(account.accountId),
    });
    return true;
  }

  return false;
}

async function handleV2Post(
  pathname: string,
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<boolean> {
  if (pathname === "/api/auth/qr/start") {
    const result = await startLogin({
      sessionKey: getOptionalString(body, "sessionKey"),
      force: body.force === true,
      botType: getOptionalString(body, "botType"),
      credential: getRequiredCredential(body),
    });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (pathname === "/api/auth/qr/wait") {
    const result = await waitLogin({
      sessionKey: getRequiredString(body, "sessionKey"),
      timeoutMs: getOptionalNumber(body, "timeoutMs"),
      botType: getOptionalString(body, "botType"),
    });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (pathname === "/api/updates/get") {
    const { credential, account } = getV2AccountContext(body);
    const messages = await collectV2Updates({
      account,
      timeoutMs: getOptionalNumber(body, "timeoutMs"),
    });
    sendJson(res, 200, {
      ok: true,
      credential,
      accountId: account.accountId,
      messages,
    });
    return true;
  }

  if (pathname === "/api/messages/text") {
    const { credential, account, opts } = getV2AccountContext(body);
    const { conversation, contextToken } = getConversationContext(
      account,
      getRequiredString(body, "conversationId"),
    );
    const result = await sendTextMessage({
      to: conversation.peerUserId,
      text: getRequiredString(body, "text"),
      contextToken,
      opts,
      includeSentMessages: true,
    });
    if (result.sentMessages?.length) {
      recordOutgoingMessages({
        accountId: account.accountId,
        peerUserId: conversation.peerUserId,
        messages: result.sentMessages,
      });
    }
    sendJson(res, 200, {
      ok: true,
      credential,
      accountId: account.accountId,
      conversationId: conversation.conversationId,
      messageId: result.messageId,
    });
    return true;
  }

  if (pathname === "/api/messages/media") {
    const { credential, account, opts } = getV2AccountContext(body);
    const { conversation, contextToken } = getConversationContext(
      account,
      getRequiredString(body, "conversationId"),
    );
    const result = await sendMediaMessage({
      to: conversation.peerUserId,
      text: getOptionalString(body, "text"),
      mediaPathOrUrl: getRequiredString(body, "media"),
      contextToken,
      opts,
      cdnBaseUrl: account.cdnBaseUrl,
      includeSentMessages: true,
    });
    if (result.sentMessages?.length) {
      recordOutgoingMessages({
        accountId: account.accountId,
        peerUserId: conversation.peerUserId,
        messages: result.sentMessages,
      });
    }
    sendJson(res, 200, {
      ok: true,
      credential,
      accountId: account.accountId,
      conversationId: conversation.conversationId,
      messageId: result.messageId,
      uploadedKind: result.uploadedKind,
      localFilePath: result.localFilePath,
    });
    return true;
  }

  if (pathname === "/api/upload-url/get") {
    const { credential, account, opts } = getV2AccountContext(body);
    const conversationId = getOptionalString(body, "conversationId");
    const conversation = conversationId
      ? requireConversation(account.accountId, conversationId)
      : null;
    const result = await getUploadUrl({
      ...opts,
      filekey: getOptionalString(body, "filekey"),
      media_type: getOptionalNumber(body, "mediaType"),
      to_user_id: conversation?.peerUserId,
      rawsize: getOptionalNumber(body, "rawsize"),
      rawfilemd5: getOptionalString(body, "rawfilemd5"),
      filesize: getOptionalNumber(body, "filesize"),
      thumb_rawsize: getOptionalNumber(body, "thumbRawsize"),
      thumb_rawfilemd5: getOptionalString(body, "thumbRawfilemd5"),
      thumb_filesize: getOptionalNumber(body, "thumbFilesize"),
      no_need_thumb: body.noNeedThumb === true,
      aeskey: getOptionalString(body, "aeskey"),
    });
    sendJson(res, 200, {
      ok: true,
      credential,
      accountId: account.accountId,
      result,
    });
    return true;
  }

  if (pathname === "/api/config/get") {
    const { credential, account, opts } = getV2AccountContext(body);
    const { conversation, contextToken } = getConversationContext(
      account,
      getRequiredString(body, "conversationId"),
    );
    const result = await getConfig({
      ...opts,
      ilinkUserId: conversation.peerUserId,
      contextToken,
    });
    sendJson(res, 200, {
      ok: true,
      credential,
      accountId: account.accountId,
      conversationId: conversation.conversationId,
      result,
    });
    return true;
  }

  if (pathname === "/api/typing/send") {
    const { credential, account, opts } = getV2AccountContext(body);
    const { conversation } = getConversationContext(
      account,
      getRequiredString(body, "conversationId"),
    );
    await sendTyping({
      ...opts,
      body: {
        ilink_user_id: conversation.peerUserId,
        typing_ticket: getRequiredString(body, "typingTicket"),
        status: getOptionalNumber(body, "status") ?? 1,
      },
    });
    sendJson(res, 200, {
      ok: true,
      credential,
      accountId: account.accountId,
      conversationId: conversation.conversationId,
    });
    return true;
  }

  return false;
}

async function handleLegacyPost(
  pathname: string,
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<boolean> {
  if (pathname === "/api/auth/qr/start") {
    sendJson(res, 410, {
      ok: false,
      error: "deprecated interface: use /api/v2/auth/qr/start with credential",
    });
    return true;
  }

  if (pathname === "/api/auth/qr/wait") {
    const result = await waitLogin({
      sessionKey: getRequiredString(body, "sessionKey"),
      timeoutMs: getOptionalNumber(body, "timeoutMs"),
      botType: getOptionalString(body, "botType"),
    });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (pathname === "/api/updates/get") {
    const { account, opts } = getAccountContext(body);
    const requestCursor = getOptionalString(body, "getUpdatesBuf");
    const result = await getUpdates({
      ...opts,
      baseUrl: getOptionalString(body, "baseUrl") || account.baseUrl,
      get_updates_buf: requestCursor ?? getStoredUpdatesCursor(account.accountId),
      timeoutMs: getOptionalNumber(body, "timeoutMs"),
    });
    if (typeof result.get_updates_buf === "string" && result.get_updates_buf) {
      saveUpdatesCursor(account.accountId, result.get_updates_buf);
    }
    recordIncomingMessages({
      accountId: account.accountId,
      accountUserId: account.userId,
      messages: result.msgs ?? [],
    });
    sendJson(res, 200, { ok: true, accountId: account.accountId, result });
    return true;
  }

  if (pathname === "/api/messages/text") {
    const { account, opts } = getAccountContext(body);
    const to = getRequiredString(body, "to");
    const contextToken =
      getOptionalString(body, "contextToken") || getStoredContextToken(account.accountId, to);
    const result = await sendTextMessage({
      to,
      text: getRequiredString(body, "text"),
      contextToken,
      opts,
      includeSentMessages: true,
    });
    if (result.sentMessages?.length) {
      recordOutgoingMessages({
        accountId: account.accountId,
        peerUserId: to,
        messages: result.sentMessages,
      });
    }
    sendJson(res, 200, {
      ok: true,
      accountId: account.accountId,
      messageId: result.messageId,
    });
    return true;
  }

  if (pathname === "/api/messages/media") {
    const { account, opts } = getAccountContext(body);
    const to = getRequiredString(body, "to");
    const contextToken =
      getOptionalString(body, "contextToken") || getStoredContextToken(account.accountId, to);
    const result = await sendMediaMessage({
      to,
      text: getOptionalString(body, "text"),
      mediaPathOrUrl: getRequiredString(body, "media"),
      contextToken,
      opts,
      cdnBaseUrl: account.cdnBaseUrl,
      includeSentMessages: true,
    });
    if (result.sentMessages?.length) {
      recordOutgoingMessages({
        accountId: account.accountId,
        peerUserId: to,
        messages: result.sentMessages,
      });
    }
    sendJson(res, 200, {
      ok: true,
      accountId: account.accountId,
      messageId: result.messageId,
      uploadedKind: result.uploadedKind,
      localFilePath: result.localFilePath,
    });
    return true;
  }

  if (pathname === "/api/upload-url/get") {
    const { account, opts } = getAccountContext(body);
    const result = await getUploadUrl({
      ...opts,
      filekey: getOptionalString(body, "filekey"),
      media_type: getOptionalNumber(body, "mediaType"),
      to_user_id: getOptionalString(body, "toUserId"),
      rawsize: getOptionalNumber(body, "rawsize"),
      rawfilemd5: getOptionalString(body, "rawfilemd5"),
      filesize: getOptionalNumber(body, "filesize"),
      thumb_rawsize: getOptionalNumber(body, "thumbRawsize"),
      thumb_rawfilemd5: getOptionalString(body, "thumbRawfilemd5"),
      thumb_filesize: getOptionalNumber(body, "thumbFilesize"),
      no_need_thumb: body.noNeedThumb === true,
      aeskey: getOptionalString(body, "aeskey"),
    });
    sendJson(res, 200, { ok: true, accountId: account.accountId, result });
    return true;
  }

  if (pathname === "/api/config/get") {
    const { account, opts } = getAccountContext(body);
    const result = await getConfig({
      ...opts,
      ilinkUserId: getRequiredString(body, "ilinkUserId"),
      contextToken: getOptionalString(body, "contextToken"),
    });
    sendJson(res, 200, { ok: true, accountId: account.accountId, result });
    return true;
  }

  if (pathname === "/api/typing/send") {
    const { account, opts } = getAccountContext(body);
    await sendTyping({
      ...opts,
      body: {
        ilink_user_id: getRequiredString(body, "ilinkUserId"),
        typing_ticket: getRequiredString(body, "typingTicket"),
        status: getOptionalNumber(body, "status") ?? 1,
      },
    });
    sendJson(res, 200, { ok: true, accountId: account.accountId });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const apiVersion = detectApiVersion(url.pathname);
    const pathname = normalizeApiPath(url.pathname);

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        service: "openclaw-weixin-http",
        time: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && apiVersion === "v2" && (await handleV2Get(pathname, url, res))) {
      return;
    }

    if (req.method === "GET" && pathname === "/api/accounts") {
      sendJson(res, 200, { ok: true, accounts: listAccounts() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const accountId = url.searchParams.get("accountId")?.trim();
      if (!accountId) {
        throw new Error("missing required query param: accountId");
      }
      sendJson(res, 200, {
        ok: true,
        accountId,
        state: getAccountSessionState(accountId),
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new Error("request body must be a JSON object");
    }
    logIncomingRequest(req.method || "POST", url.toString(), body);

    if (apiVersion === "v2" && (await handleV2Post(pathname, body, res))) {
      return;
    }

    if (await handleLegacyPost(pathname, body, res)) {
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("request failed", { error: message });
    sendJson(res, 400, { ok: false, error: message });
  }
});

server.listen(appConfig.port, appConfig.host, () => {
  logger.info("server started", {
    host: appConfig.host,
    port: appConfig.port,
    stateDir: appConfig.stateDir,
  });
});
