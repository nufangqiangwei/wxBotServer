import { createCipheriv } from "node:crypto";

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

export async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const url = params.uploadFullUrl?.trim()
    ? params.uploadFullUrl
    : params.uploadParam
      ? buildCdnUploadUrl({
          cdnBaseUrl: params.cdnBaseUrl,
          uploadParam: params.uploadParam,
          filekey: params.filekey,
        })
      : null;

  if (!url) {
    throw new Error("CDN upload URL missing");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`CDN upload client error ${res.status}: ${await res.text()}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN upload server error ${res.status}: ${await res.text()}`);
      }
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new Error("CDN upload response missing x-encrypted-param");
      }
      return { downloadParam };
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("CDN upload failed");
}