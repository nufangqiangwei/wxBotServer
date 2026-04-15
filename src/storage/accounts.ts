import fs from "node:fs";
import path from "node:path";

import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL } from "../config.ts";
import { ensureDir, resolveAccountsDir } from "./files.ts";

export type AccountRecord = {
  accountId: string;
  credential?: string;
  botToken: string;
  baseUrl: string;
  cdnBaseUrl: string;
  userId?: string;
  savedAt: string;
};

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

export function saveAccount(record: AccountRecord): void {
  ensureDir(resolveAccountsDir());
  fs.writeFileSync(resolveAccountPath(record.accountId), JSON.stringify(record, null, 2), "utf-8");
}

export function loadAccount(accountId: string): AccountRecord | null {
  const filePath = resolveAccountPath(accountId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AccountRecord;
}

export function listAccounts(): AccountRecord[] {
  const dir = resolveAccountsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".state.json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as AccountRecord)
    .map((account) => ({
      ...account,
      baseUrl: account.baseUrl || DEFAULT_BASE_URL,
      cdnBaseUrl: account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
    }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function requireAccount(accountId: string): AccountRecord {
  const account = loadAccount(accountId);
  if (!account) {
    throw new Error(`account not found: ${accountId}`);
  }
  return {
    ...account,
    baseUrl: account.baseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: account.cdnBaseUrl || DEFAULT_CDN_BASE_URL,
  };
}

export function loadAccountByCredential(credential: string): AccountRecord | null {
  const normalized = credential.trim();
  if (!normalized) return null;
  return listAccounts().find((account) => account.credential === normalized) ?? null;
}

export function requireAccountByCredential(credential: string): AccountRecord {
  const account = loadAccountByCredential(credential);
  if (!account) {
    throw new Error(`account credential not found: ${credential}`);
  }
  return account;
}
