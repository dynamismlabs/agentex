import type { InboundMessage } from "../../src/types.js";

let msgCounter = 0;

function nextId(): string {
  return `msg-${++msgCounter}`;
}

export function resetMessageCounter(): void {
  msgCounter = 0;
}

export function directMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: nextId(),
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    chatType: "direct",
    target: "user-1",
    text: "Hello agent",
    timestamp: Date.now(),
    ...overrides,
  };
}

export function groupMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: nextId(),
    channel: "test",
    senderId: "user-2",
    senderName: "Group User",
    chatType: "group",
    target: "group-123",
    text: "Hey @bot do something",
    timestamp: Date.now(),
    ...overrides,
  };
}

export function threadMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: nextId(),
    channel: "test",
    senderId: "user-3",
    senderName: "Thread User",
    chatType: "thread",
    target: "channel-456",
    threadId: "thread-789",
    text: "Review this code please",
    timestamp: Date.now(),
    ...overrides,
  };
}

export function webhookMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: nextId(),
    channel: "webhook",
    senderId: "webhook",
    chatType: "direct",
    target: "github-events",
    text: "PR #42 opened by user",
    timestamp: Date.now(),
    raw: { type: "pull_request", action: "opened" },
    ...overrides,
  };
}
