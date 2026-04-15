import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getUploadUrl, type WeixinApiOptions } from "./api.ts";
import { aesEcbPaddedSize, uploadBufferToCdn } from "./cdn.ts";
import { UploadMediaType } from "../types/weixin.ts";
import { tempFileName } from "../utils/random.ts";
import { resolveTempDir } from "../storage/files.ts";

export type UploadedFileInfo = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
};

function getMimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

function getExtensionFromContentTypeOrUrl(contentType: string | null, rawUrl: string): string {
  const normalized = contentType?.split(";")[0].trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
  }

  try {
    const ext = path.extname(new URL(rawUrl).pathname).toLowerCase();
    return ext || ".bin";
  } catch {
    return ".bin";
  }
}

export async function downloadRemoteMediaToTemp(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`remote media download failed: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = getExtensionFromContentTypeOrUrl(res.headers.get("content-type"), url);
  const filePath = path.join(resolveTempDir(), tempFileName("weixin-remote", ext));
  await fs.writeFile(filePath, buf);
  return filePath;
}

async function uploadMedia(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
}): Promise<UploadedFileInfo> {
  const plaintext = await fs.readFile(params.filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    ...params.opts,
    filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadUrlResp.upload_full_url?.trim() || undefined,
    uploadParam: uploadUrlResp.upload_param ?? undefined,
    filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aeskey,
  });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export async function uploadFileForWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo & { kind: "image" | "video" | "file"; fileName: string }> {
  const mime = getMimeFromFilename(params.filePath);
  const fileName = path.basename(params.filePath);

  if (mime.startsWith("video/")) {
    const uploaded = await uploadMedia({
      ...params,
      mediaType: UploadMediaType.VIDEO,
    });
    return { ...uploaded, kind: "video", fileName };
  }

  if (mime.startsWith("image/")) {
    const uploaded = await uploadMedia({
      ...params,
      mediaType: UploadMediaType.IMAGE,
    });
    return { ...uploaded, kind: "image", fileName };
  }

  const uploaded = await uploadMedia({
    ...params,
    mediaType: UploadMediaType.FILE,
  });
  return { ...uploaded, kind: "file", fileName };
}