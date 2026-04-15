import { randomUUID } from "node:crypto";

import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL } from "../config.ts";
import { loadAccountByCredential, saveAccount } from "../storage/accounts.ts";
import { fetchQRCode as fetchQRCodeFromApi, pollQRStatus as pollQRStatusFromApi } from "./api.ts";

type ActiveLogin = {
  sessionKey: string;
  credential?: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  waitRequestedAt?: number;
  currentApiBaseUrl: string;
};

type LoginDependencies = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchQRCode: typeof fetchQRCodeFromApi;
  pollQRStatus: typeof pollQRStatusFromApi;
};

const activeLogins = new Map<string, ActiveLogin>();
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const UNUSED_LOGIN_TTL_MS = 3 * 60_000;
const UNUSED_LOGIN_CLEANUP_INTERVAL_MS = 30_000;
const MAX_QR_REFRESH_COUNT = 3;
export const DEFAULT_ILINK_BOT_TYPE = "3";

const defaultLoginDependencies: LoginDependencies = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetchQRCode: fetchQRCodeFromApi,
  pollQRStatus: pollQRStatusFromApi,
};

let loginDependencies: LoginDependencies = defaultLoginDependencies;

function now(): number {
  return loginDependencies.now();
}

function isLoginFresh(login: ActiveLogin): boolean {
  return now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function isUnusedLoginStale(login: ActiveLogin): boolean {
  return login.waitRequestedAt === undefined && now() - login.startedAt >= UNUSED_LOGIN_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [key, value] of activeLogins) {
    if (!isLoginFresh(value)) {
      activeLogins.delete(key);
    }
  }
}

function purgeUnusedLogins(): void {
  for (const [key, value] of activeLogins) {
    if (isUnusedLoginStale(value)) {
      activeLogins.delete(key);
    }
  }
}

function assertCredentialAvailable(credential: string, currentSessionKey?: string): void {
  const normalized = credential.trim();
  if (!normalized) {
    throw new Error("missing required string field: credential");
  }
  for (const [sessionKey, login] of activeLogins) {
    if (sessionKey === currentSessionKey) continue;
    if (!isLoginFresh(login)) continue;
    if (login.credential === normalized) {
      throw new Error(`credential already in pending login: ${normalized}`);
    }
  }
}

export async function startLogin(params?: {
  sessionKey?: string;
  force?: boolean;
  botType?: string;
  credential?: string;
}): Promise<{ sessionKey: string; qrcodeUrl?: string; message: string; credential?: string }> {
  const sessionKey = params?.sessionKey?.trim() || randomUUID();
  purgeUnusedLogins();
  purgeExpiredLogins();
  const credential = params?.credential?.trim();

  if (credential) {
    assertCredentialAvailable(credential, sessionKey);
  }

  const existing = activeLogins.get(sessionKey);
  if (existing && isLoginFresh(existing) && !params?.force) {
    return {
      sessionKey,
      credential: existing.credential,
      qrcodeUrl: existing.qrcodeUrl,
      message: "QR code already active",
    };
  }

  const botType = params?.botType?.trim() || DEFAULT_ILINK_BOT_TYPE;
  const qr = await loginDependencies.fetchQRCode(DEFAULT_BASE_URL, botType);
  activeLogins.set(sessionKey, {
    sessionKey,
    credential,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: now(),
    currentApiBaseUrl: DEFAULT_BASE_URL,
  });

  return {
    sessionKey,
    credential,
    qrcodeUrl: qr.qrcode_img_content,
    message: "QR code created",
  };
}

export async function waitLogin(params: {
  sessionKey: string;
  timeoutMs?: number;
  botType?: string;
}): Promise<{
  connected: boolean;
  message: string;
  accountId?: string;
  credential?: string;
  userId?: string;
  baseUrl?: string;
}> {
  purgeUnusedLogins();
  const login = activeLogins.get(params.sessionKey);
  if (!login) {
    return { connected: false, message: "login session not found" };
  }
  login.waitRequestedAt ??= now();
  if (!isLoginFresh(login)) {
    activeLogins.delete(params.sessionKey);
    return { connected: false, message: "login session expired" };
  }

  const deadline = now() + Math.max(params.timeoutMs ?? 480_000, 1_000);
  let refreshCount = 1;
  const botType = params.botType?.trim() || DEFAULT_ILINK_BOT_TYPE;

  while (now() < deadline) {
    const status = await loginDependencies.pollQRStatus(login.currentApiBaseUrl, login.qrcode);
    switch (status.status) {
      case "wait":
      case "scaned":
        await loginDependencies.sleep(1_000);
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          login.currentApiBaseUrl = `https://${status.redirect_host}`;
        }
        await loginDependencies.sleep(1_000);
        break;
      case "expired":
        refreshCount += 1;
        if (refreshCount > MAX_QR_REFRESH_COUNT) {
          activeLogins.delete(params.sessionKey);
          return { connected: false, message: "QR code expired too many times" };
        }
        {
          const qr = await loginDependencies.fetchQRCode(DEFAULT_BASE_URL, botType);
          login.qrcode = qr.qrcode;
          login.qrcodeUrl = qr.qrcode_img_content;
          login.startedAt = now();
          login.currentApiBaseUrl = DEFAULT_BASE_URL;
        }
        await loginDependencies.sleep(1_000);
        break;
      case "confirmed":
        if (!status.bot_token || !status.ilink_bot_id) {
          activeLogins.delete(params.sessionKey);
          return { connected: false, message: "confirmed without token or account id" };
        }
        if (login.credential) {
          const existingAccount = loadAccountByCredential(login.credential);
          if (existingAccount && existingAccount.accountId !== status.ilink_bot_id) {
            activeLogins.delete(params.sessionKey);
            return {
              connected: false,
              message: `credential already bound to another account: ${login.credential}`,
            };
          }
        }
        saveAccount({
          accountId: status.ilink_bot_id,
          credential: login.credential,
          botToken: status.bot_token,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
          cdnBaseUrl: DEFAULT_CDN_BASE_URL,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        });
        activeLogins.delete(params.sessionKey);
        return {
          connected: true,
          message: "login confirmed",
          accountId: status.ilink_bot_id,
          credential: login.credential,
          userId: status.ilink_user_id,
          baseUrl: status.baseurl || DEFAULT_BASE_URL,
        };
    }
  }

  return { connected: false, message: "login timed out" };
}

const unusedLoginCleanupTimer = setInterval(purgeUnusedLogins, UNUSED_LOGIN_CLEANUP_INTERVAL_MS);
unusedLoginCleanupTimer.unref?.();

export const __loginTestHooks = {
  reset(): void {
    activeLogins.clear();
    loginDependencies = defaultLoginDependencies;
  },
  setDependencies(deps: Partial<LoginDependencies>): void {
    loginDependencies = {
      ...loginDependencies,
      ...deps,
    };
  },
  purgeUnusedLogins,
};
