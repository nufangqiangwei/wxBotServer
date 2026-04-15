import path from "node:path";

import type { WeixinApiOptions } from "./api.ts";
import { sendMessage as sendMessageApi } from "./api.ts";
import {
  MessageItemType,
  MessageState,
  MessageType,
  type MessageItem,
  type WeixinMessage,
  type SendMessageReq,
} from "../types/weixin.ts";
import { generateId } from "../utils/random.ts";
import { downloadRemoteMediaToTemp, uploadFileForWeixin } from "./media.ts";

function generateClientId(): string {
  return generateId("weixin-http");
}

function buildWeixinMessage(params: {
  to: string;
  itemList?: MessageItem[];
  contextToken?: string;
  clientId: string;
}): WeixinMessage {
  return {
    from_user_id: "",
    to_user_id: params.to,
    client_id: params.clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: params.itemList?.length ? params.itemList : undefined,
    context_token: params.contextToken,
  };
}

function buildTextMessage(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const message = buildWeixinMessage({
    to: params.to,
    itemList: params.text
      ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
      : [],
    contextToken: params.contextToken,
    clientId: params.clientId,
  });

  return {
    msg: message,
  };
}

export async function sendTextMessage(params: {
  to: string;
  text: string;
  contextToken?: string;
  opts: WeixinApiOptions;
  includeSentMessages?: boolean;
}): Promise<{ messageId: string; sentMessages?: WeixinMessage[] }> {
  const clientId = generateClientId();
  const body = buildTextMessage({
    to: params.to,
    text: params.text,
    contextToken: params.contextToken,
    clientId,
  });
  await sendMessageApi({
    ...params.opts,
    body,
  });
  return {
    messageId: clientId,
    sentMessages: params.includeSentMessages && body.msg ? [body.msg] : undefined,
  };
}

async function sendMediaItems(params: {
  to: string;
  text?: string;
  mediaItem: MessageItem;
  contextToken?: string;
  opts: WeixinApiOptions;
  includeSentMessages?: boolean;
}): Promise<{ messageId: string; sentMessages?: WeixinMessage[] }> {
  const items: MessageItem[] = [];
  if (params.text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text: params.text } });
  }
  items.push(params.mediaItem);

  let lastClientId = "";
  const sentMessages: WeixinMessage[] = [];
  for (const item of items) {
    lastClientId = generateClientId();
    const message = buildWeixinMessage({
      to: params.to,
      itemList: [item],
      contextToken: params.contextToken,
      clientId: lastClientId,
    });
    await sendMessageApi({
      ...params.opts,
      body: {
        msg: message,
      },
    });
    if (params.includeSentMessages) {
      sentMessages.push(message);
    }
  }

  return {
    messageId: lastClientId,
    sentMessages: params.includeSentMessages ? sentMessages : undefined,
  };
}

export async function sendMediaMessage(params: {
  to: string;
  text?: string;
  mediaPathOrUrl: string;
  contextToken?: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  includeSentMessages?: boolean;
}): Promise<{
  messageId: string;
  uploadedKind: string;
  localFilePath: string;
  sentMessages?: WeixinMessage[];
}> {
  let filePath = params.mediaPathOrUrl;
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    filePath = await downloadRemoteMediaToTemp(filePath);
  } else if (filePath.startsWith("file://")) {
    filePath = new URL(filePath).pathname;
  } else if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(filePath);
  }

  const uploaded = await uploadFileForWeixin({
    filePath,
    toUserId: params.to,
    opts: params.opts,
    cdnBaseUrl: params.cdnBaseUrl,
  });

  if (uploaded.kind === "image") {
    return {
      ...(await sendMediaItems({
        to: params.to,
        text: params.text,
        contextToken: params.contextToken,
        opts: params.opts,
        includeSentMessages: params.includeSentMessages,
        mediaItem: {
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
              encrypt_type: 1,
            },
            mid_size: uploaded.fileSizeCiphertext,
          },
        },
      })),
      uploadedKind: uploaded.kind,
      localFilePath: filePath,
    };
  }

  if (uploaded.kind === "video") {
    return {
      ...(await sendMediaItems({
        to: params.to,
        text: params.text,
        contextToken: params.contextToken,
        opts: params.opts,
        includeSentMessages: params.includeSentMessages,
        mediaItem: {
          type: MessageItemType.VIDEO,
          video_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
              encrypt_type: 1,
            },
            video_size: uploaded.fileSizeCiphertext,
          },
        },
      })),
      uploadedKind: uploaded.kind,
      localFilePath: filePath,
    };
  }

  return {
    ...(await sendMediaItems({
      to: params.to,
      text: params.text,
      contextToken: params.contextToken,
      opts: params.opts,
      includeSentMessages: params.includeSentMessages,
      mediaItem: {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
            encrypt_type: 1,
          },
          file_name: uploaded.fileName,
          len: String(uploaded.fileSize),
        },
      },
    })),
    uploadedKind: uploaded.kind,
    localFilePath: filePath,
  };
}
