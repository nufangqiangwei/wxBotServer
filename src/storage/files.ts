import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../config.ts";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function resolveStateDir(): string {
  const cfg = loadConfig();
  migrateLegacyStateDir(cfg.stateDir);
  ensureDir(cfg.stateDir);
  return cfg.stateDir;
}

export function resolveAccountsDir(): string {
  const dir = path.join(resolveStateDir(), "accounts");
  ensureDir(dir);
  return dir;
}

export function resolveTempDir(): string {
  const dir = path.join(resolveStateDir(), "tmp");
  ensureDir(dir);
  return dir;
}

let migrationChecked = false;

function migrateLegacyStateDir(targetDir: string): void {
  if (migrationChecked) return;
  migrationChecked = true;

  const legacyDir = path.join(os.homedir(), ".openclaw-weixin-http");
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return;
  if (!fs.existsSync(legacyDir)) return;

  ensureDir(targetDir);
  const targetEntries = fs.readdirSync(targetDir, { withFileTypes: true });
  if (targetEntries.length > 0) return;

  for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
    const src = path.join(legacyDir, entry.name);
    const dest = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}
