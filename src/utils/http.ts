import { logger } from "./logger.ts";
import { redactBody, redactUrl } from "./redact.ts";

export async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

export function sendJson(
  res: import("node:http").ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const text = JSON.stringify(body, null, 2);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(text);
}

export function logIncomingRequest(method: string, url: string, body?: unknown): void {
  logger.info("incoming request", {
    method,
    url: redactUrl(url),
    body: body == null ? undefined : redactBody(JSON.stringify(body)),
  });
}