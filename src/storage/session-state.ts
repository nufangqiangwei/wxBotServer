import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { WeixinMessage } from "../types/weixin.ts";
import { ensureDir, resolveAccountsDir } from "./files.ts";

export type StoredConversation = {
  conversationId: string;
  peerUserId: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: number;
  lastContextToken?: string;
};

export type StoredConversationMessage = {
  recordId: string;
  messageKey: string;
  conversationId: string;
  peerUserId: string;
  direction: "incoming" | "outgoing";
  message: WeixinMessage;
  recordedAt: string;
};

type AccountSessionState = {
  getUpdatesBuf?: string;
  contextTokens?: Record<string, string>;
  userConversations?: Record<string, string>;
  conversations?: Record<string, StoredConversation>;
  history?: StoredConversationMessage[];
  pendingMessages?: StoredConversationMessage[];
  updatedAt: string;
};

function resolveStatePath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.state.json`);
}

function normalizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function ensureCollections(state: AccountSessionState): void {
  state.contextTokens = state.contextTokens ?? {};
  state.userConversations = state.userConversations ?? {};
  state.conversations = state.conversations ?? {};
  state.history = state.history ?? [];
  state.pendingMessages = state.pendingMessages ?? [];
}

function ensureConversationInternal(
  state: AccountSessionState,
  peerUserId: string,
  nowIso: string,
): StoredConversation {
  ensureCollections(state);
  const userConversations = state.userConversations!;
  const conversations = state.conversations!;
  const normalizedPeerUserId = peerUserId.trim();
  const existingId = userConversations[normalizedPeerUserId];
  if (existingId && conversations[existingId]) {
    return conversations[existingId];
  }

  const conversationId = randomUUID();
  const conversation: StoredConversation = {
    conversationId,
    peerUserId: normalizedPeerUserId,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  userConversations[normalizedPeerUserId] = conversationId;
  conversations[conversationId] = conversation;
  return conversation;
}

function migrateLegacyState(state: AccountSessionState): AccountSessionState {
  ensureCollections(state);
  const nowIso = state.updatedAt || new Date(0).toISOString();
  for (const [peerUserId, contextToken] of Object.entries(state.contextTokens ?? {})) {
    const conversation = ensureConversationInternal(state, peerUserId, nowIso);
    if (contextToken && !conversation.lastContextToken) {
      conversation.lastContextToken = contextToken;
    }
  }
  return state;
}

function loadState(accountId: string): AccountSessionState {
  const filePath = resolveStatePath(accountId);
  if (!fs.existsSync(filePath)) {
    return migrateLegacyState({ updatedAt: new Date(0).toISOString() });
  }
  return migrateLegacyState(
    JSON.parse(fs.readFileSync(filePath, "utf-8")) as AccountSessionState,
  );
}

function saveState(accountId: string, state: AccountSessionState): void {
  ensureDir(resolveAccountsDir());
  fs.writeFileSync(resolveStatePath(accountId), JSON.stringify(state, null, 2), "utf-8");
}

function buildMessageKey(message: WeixinMessage, conversationId: string): string {
  const clientId = normalizeId(message.client_id);
  if (clientId) {
    return `client:${clientId}`;
  }
  if (typeof message.message_id === "number") {
    return `message:${message.message_id}`;
  }
  if (typeof message.seq === "number") {
    return `seq:${conversationId}:${message.seq}`;
  }
  return [
    "composite",
    conversationId,
    normalizeId(message.from_user_id) ?? "",
    normalizeId(message.to_user_id) ?? "",
    String(message.create_time_ms ?? 0),
    String(message.update_time_ms ?? 0),
    String(message.item_list?.length ?? 0),
  ].join(":");
}

function buildOwnedIds(accountId: string, accountUserId?: string): Set<string> {
  const ownedIds = [normalizeId(accountId)].filter((value): value is string => Boolean(value));
  return new Set(ownedIds);
}

function resolvePeerUserId(
  accountId: string,
  accountUserId: string | undefined,
  message: WeixinMessage,
): string {
  const fromUserId = normalizeId(message.from_user_id);
  const toUserId = normalizeId(message.to_user_id);
  const sessionId = normalizeId(message.session_id);
  const ownedIds = buildOwnedIds(accountId, accountUserId);

  if (fromUserId && !ownedIds.has(fromUserId)) {
    return fromUserId;
  }
  if (toUserId && !ownedIds.has(toUserId)) {
    return toUserId;
  }
  if (fromUserId) return fromUserId;
  if (toUserId) return toUserId;
  if (sessionId) return `session:${sessionId}`;
  return "unknown";
}

function inferDirection(
  accountId: string,
  accountUserId: string | undefined,
  message: WeixinMessage,
): "incoming" | "outgoing" {
  const fromUserId = normalizeId(message.from_user_id);
  if (!fromUserId) return "incoming";
  return buildOwnedIds(accountId, accountUserId).has(fromUserId) ? "outgoing" : "incoming";
}

function sortMessagesByTime(
  left: StoredConversationMessage,
  right: StoredConversationMessage,
): number {
  const leftTimestamp = left.message.create_time_ms ?? Date.parse(left.recordedAt);
  const rightTimestamp = right.message.create_time_ms ?? Date.parse(right.recordedAt);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return left.recordedAt.localeCompare(right.recordedAt);
}

function appendMessages(params: {
  accountId: string;
  accountUserId?: string;
  peerUserId?: string;
  direction?: "incoming" | "outgoing";
  messages: WeixinMessage[];
}): StoredConversationMessage[] {
  if (!params.messages.length) return [];

  const next = loadState(params.accountId);
  ensureCollections(next);

  const existingKeys = new Set((next.history ?? []).map((entry) => entry.messageKey));
  const contextTokens = next.contextTokens!;
  const history = next.history!;
  const pendingMessages = next.pendingMessages!;
  const storedMessages: StoredConversationMessage[] = [];

  for (const message of params.messages) {
    const nowIso = new Date().toISOString();
    const peerUserId =
      params.peerUserId?.trim() ||
      resolvePeerUserId(params.accountId, params.accountUserId, message);
    const conversation = ensureConversationInternal(next, peerUserId, nowIso);
    const messageKey = buildMessageKey(message, conversation.conversationId);
    if (existingKeys.has(messageKey)) {
      continue;
    }

    const contextToken = normalizeId(message.context_token);
    if (contextToken) {
      contextTokens[peerUserId] = contextToken;
      conversation.lastContextToken = contextToken;
    }

    conversation.updatedAt = nowIso;
    conversation.lastMessageAt = message.create_time_ms ?? Date.now();

    const entry: StoredConversationMessage = {
      recordId: randomUUID(),
      messageKey,
      conversationId: conversation.conversationId,
      peerUserId,
      direction:
        params.direction ?? inferDirection(params.accountId, params.accountUserId, message),
      message,
      recordedAt: nowIso,
    };
    history.push(entry);
    pendingMessages.push(entry);
    existingKeys.add(messageKey);
    storedMessages.push(entry);
  }

  if (!storedMessages.length) return [];
  next.updatedAt = new Date().toISOString();
  saveState(params.accountId, next);
  return storedMessages;
}

export function getStoredUpdatesCursor(accountId: string): string {
  return loadState(accountId).getUpdatesBuf ?? "";
}

export function saveUpdatesCursor(accountId: string, getUpdatesBuf: string): void {
  const next = loadState(accountId);
  next.getUpdatesBuf = getUpdatesBuf;
  next.updatedAt = new Date().toISOString();
  saveState(accountId, next);
}

export function getStoredContextToken(accountId: string, userId: string): string | undefined {
  const map = loadState(accountId).contextTokens ?? {};
  return map[userId];
}

export function saveContextToken(accountId: string, userId: string, contextToken: string): void {
  const next = loadState(accountId);
  ensureCollections(next);
  const nowIso = new Date().toISOString();
  next.contextTokens![userId] = contextToken;
  const conversation = ensureConversationInternal(next, userId, nowIso);
  conversation.lastContextToken = contextToken;
  conversation.updatedAt = nowIso;
  next.updatedAt = nowIso;
  saveState(accountId, next);
}

export function recordIncomingMessages(params: {
  accountId: string;
  accountUserId?: string;
  messages: WeixinMessage[];
}): StoredConversationMessage[] {
  return appendMessages(params);
}

export function recordOutgoingMessages(params: {
  accountId: string;
  peerUserId: string;
  messages: WeixinMessage[];
}): StoredConversationMessage[] {
  return appendMessages({
    accountId: params.accountId,
    peerUserId: params.peerUserId,
    direction: "outgoing",
    messages: params.messages,
  });
}

export function consumePendingMessages(accountId: string): StoredConversationMessage[] {
  const next = loadState(accountId);
  ensureCollections(next);
  const messages = [...(next.pendingMessages ?? [])].sort(sortMessagesByTime);
  if (!messages.length) return [];
  next.pendingMessages = [];
  next.updatedAt = new Date().toISOString();
  saveState(accountId, next);
  return messages;
}

export function getConversation(accountId: string, conversationId: string): StoredConversation | null {
  const current = loadState(accountId);
  return current.conversations?.[conversationId] ?? null;
}

export function requireConversation(accountId: string, conversationId: string): StoredConversation {
  const conversation = getConversation(accountId, conversationId);
  if (!conversation) {
    throw new Error(`conversation not found: ${conversationId}`);
  }
  return conversation;
}

export function listConversationHistory(accountId: string): Array<
  StoredConversation & { messageCount: number; messages: StoredConversationMessage[] }
> {
  const current = loadState(accountId);
  const conversations = Object.values(current.conversations ?? {});
  const historyByConversation = new Map<string, StoredConversationMessage[]>();

  for (const entry of current.history ?? []) {
    const list = historyByConversation.get(entry.conversationId) ?? [];
    list.push(entry);
    historyByConversation.set(entry.conversationId, list);
  }

  return conversations
    .map((conversation) => {
      const messages = [...(historyByConversation.get(conversation.conversationId) ?? [])].sort(
        sortMessagesByTime,
      );
      return {
        ...conversation,
        messageCount: messages.length,
        messages,
      };
    })
    .sort((left, right) => {
      const leftTimestamp = left.lastMessageAt ?? 0;
      const rightTimestamp = right.lastMessageAt ?? 0;
      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });
}

export function getAccountSessionState(accountId: string): {
  getUpdatesBuf: string;
  contextTokens: Record<string, string>;
  updatedAt?: string;
  pendingCount: number;
  historyCount: number;
  conversationCount: number;
  conversations: StoredConversation[];
} {
  const current = loadState(accountId);
  return {
    getUpdatesBuf: current.getUpdatesBuf ?? "",
    contextTokens: current.contextTokens ?? {},
    updatedAt: current.updatedAt,
    pendingCount: current.pendingMessages?.length ?? 0,
    historyCount: current.history?.length ?? 0,
    conversationCount: Object.keys(current.conversations ?? {}).length,
    conversations: Object.values(current.conversations ?? {}).sort((left, right) => {
      const leftTimestamp = left.lastMessageAt ?? 0;
      const rightTimestamp = right.lastMessageAt ?? 0;
      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    }),
  };
}
