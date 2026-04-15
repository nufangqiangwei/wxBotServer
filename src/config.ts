import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const DEFAULT_APP_ID = "bot";
export const DEFAULT_CHANNEL_VERSION = "0.1.0";

export type AppConfig = {
  host: string;
  port: number;
  baseUrl: string;
  cdnBaseUrl: string;
  appId: string;
  channelVersion: string;
  stateDir: string;
};

function parsePort(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveDefaultStateDir(): string {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(srcDir, "..");
  const workspaceRoot = path.resolve(packageRoot, "..");
  const workspaceStateDir = path.join(workspaceRoot, ".weixin-http-state");
  const packageStateDir = path.join(packageRoot, ".weixin-http-state");

  if (fs.existsSync(workspaceStateDir)) {
    return workspaceStateDir;
  }
  return packageStateDir;
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.WEIXIN_HTTP_HOST?.trim() || "0.0.0.0",
    port: parsePort(process.env.WEIXIN_HTTP_PORT, 8787),
    baseUrl: process.env.WEIXIN_API_BASE_URL?.trim() || DEFAULT_BASE_URL,
    cdnBaseUrl: process.env.WEIXIN_CDN_BASE_URL?.trim() || DEFAULT_CDN_BASE_URL,
    appId: process.env.WEIXIN_APP_ID?.trim() || DEFAULT_APP_ID,
    channelVersion: process.env.WEIXIN_CHANNEL_VERSION?.trim() || DEFAULT_CHANNEL_VERSION,
    stateDir: process.env.WEIXIN_HTTP_STATE_DIR?.trim() || resolveDefaultStateDir(),
  };
}
