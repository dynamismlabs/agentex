import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getAdapter } from "@agentex/adapters";
import type { AdapterModule, StreamEvent } from "@agentex/adapters";

import { loadConfig } from "./config/loader.js";
import { GatewayEventEmitterImpl } from "./events/emitter.js";
import { executeHook } from "./events/hooks.js";
import { SessionStore } from "./sessions/store.js";
import { TranscriptWriter } from "./sessions/transcript.js";
import { IdleSessionReaper } from "./sessions/reaper.js";
import { ChannelRegistry } from "./channels/registry.js";
import { checkAccess, PairingStore } from "./router/access-control.js";
import { resolveSessionKey } from "./router/session-key.js";
import { resolveAgent } from "./router/agent-router.js";
import { MessageQueue } from "./router/message-queue.js";
import { dispatchToAgent } from "./router/agent-dispatch.js";
import { routeReply } from "./router/reply-router.js";
import { ResponseStreamer } from "./router/response-streamer.js";
import { mountControlRoutes } from "./control/http.js";
import { mountWebSocket } from "./control/ws.js";

import type {
  Gateway,
  CreateGatewayOptions,
  GatewayConfig,
  GatewayEventEmitter,
  InboundMessage,
  SessionEntry,
  Logger,
  ChannelAccessConfig,
} from "./types.js";

// Built-in channel module paths (lazy loaded only when configured)
const BUILT_IN_CHANNELS: Record<string, () => Promise<{ default: import("./types.js").ChannelPlugin }>> = {
  telegram: () => import("./channels/telegram/index.js"),
  discord: () => import("./channels/discord/index.js"),
  slack: () => import("./channels/slack/index.js"),
  whatsapp: () => import("./channels/whatsapp/index.js"),
  email: () => import("./channels/email/index.js"),
  webhook: () => import("./channels/webhook/index.js"),
  cron: () => import("./channels/cron/index.js"),
};

const defaultLog: Logger = {
  info: (msg, ...args) => console.log(`[gateway] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[gateway] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[gateway] ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[gateway] ${msg}`, ...args),
};

export function createGateway(opts: CreateGatewayOptions = {}): Gateway {
  let config: GatewayConfig;
  let server: Server | null = null;
  let wsHandle: { closeAll(): void } | null = null;
  let reaper: IdleSessionReaper | null = null;
  let started = false;

  const events: GatewayEventEmitter = new GatewayEventEmitterImpl();
  const channelRegistry = new ChannelRegistry();
  const pairingStore = new PairingStore();
  const messageQueue = new MessageQueue();
  const log = defaultLog;

  // Signal handler references for cleanup
  let sigintHandler: (() => void) | null = null;
  let sigtermHandler: (() => void) | null = null;

  // Load config eagerly so `gateway.config` is available immediately
  config = loadConfig({
    configPath: opts.configPath,
    overrides: opts.config,
  });

  // Resolve state directory
  const stateDir = resolve(
    opts.stateDir ?? config.stateDir ?? `${homedir()}/.agentex`,
  );

  const sessionStore = new SessionStore(stateDir);
  const transcript = new TranscriptWriter(stateDir);

  // ----- Message pipeline handler -----
  function handleInboundMessage(msg: InboundMessage): void {
    // Run the pipeline asynchronously — errors are caught and logged
    processMessage(msg).catch((err) => {
      log.error(`Pipeline error for ${msg.channel}/${msg.senderId}: ${String(err)}`);
    });
  }

  async function processMessage(msg: InboundMessage): Promise<void> {
    events.emit("message.inbound", {
      channel: msg.channel,
      senderId: msg.senderId,
      chatType: msg.chatType,
      text: msg.text.slice(0, 200),
    }, undefined);

    // 1. Access control
    const channelConfig = (config.channels[msg.channel] ?? {}) as ChannelAccessConfig;
    const decision = checkAccess(msg, channelConfig);

    if (!decision.allowed) {
      if (decision.pendingPairing) {
        // Check if sender is already approved (has an existing session)
        const existingPairing = pairingStore.findBySender(msg.channel, msg.senderId);
        if (existingPairing) {
          existingPairing.heldMessages.push(msg);
        } else {
          const pairing = pairingStore.request(msg);
          events.emit("pairing.requested", {
            pairingId: pairing.id,
            channel: msg.channel,
            senderId: msg.senderId,
            senderName: msg.senderName ?? null,
          });
          log.info(`Pairing request from ${msg.senderId} on ${msg.channel}`);
        }
      }
      return;
    }

    // 2. Resolve agent
    const agentId = resolveAgent(msg, config.routing);
    const agentConfig = config.agents?.[agentId] ?? config.agent;

    // 3. Resolve session key
    const sessionKey = resolveSessionKey(msg, config.sessions, agentId);

    // 4. Load or create session
    let session = sessionStore.get(sessionKey);
    if (!session) {
      session = {
        key: sessionKey,
        sessionParams: null,
        lastChannel: msg.channel,
        lastRoute: {
          channel: msg.channel,
          accountId: msg.accountId,
          target: msg.chatType === "direct" ? msg.senderId : msg.target,
          threadId: msg.threadId,
        },
        lastSenderId: msg.senderId,
        lastActivityAt: Date.now(),
      };
      sessionStore.set(sessionKey, session);
      events.emit("session.created", { sessionKey }, sessionKey);
    } else {
      session.lastChannel = msg.channel;
      session.lastRoute = {
        channel: msg.channel,
        accountId: msg.accountId,
        target: msg.chatType === "direct" ? msg.senderId : msg.target,
        threadId: msg.threadId,
      };
      session.lastSenderId = msg.senderId;
      session.lastActivityAt = Date.now();
      sessionStore.set(sessionKey, session);
    }

    // 5. Write transcript
    await transcript.append(sessionKey, {
      role: "user",
      text: msg.text,
      channel: msg.channel,
      senderId: msg.senderId,
      ts: msg.timestamp,
    });
    await sessionStore.persist();

    // 6. Enqueue
    messageQueue.enqueue(sessionKey, msg, config.queue.mode, config.queue);

    // 7. If not running, dispatch
    if (!messageQueue.isRunning(sessionKey)) {
      await dispatchNext(sessionKey, agentConfig, session);
    }
  }

  async function dispatchNext(
    sessionKey: string,
    agentConfig: import("./types.js").AgentConfig,
    session: SessionEntry,
  ): Promise<void> {
    const msg = messageQueue.dequeue(sessionKey);
    if (!msg) return;

    // Handle array (collect mode)
    const messages = Array.isArray(msg) ? msg : [msg];
    const combinedText = messages.map((m) => m.text).join("\n\n");
    const primaryMsg = messages[0]!;

    messageQueue.setRunning(sessionKey, true);

    // Get adapter
    let adapter: AdapterModule;
    try {
      adapter = getAdapter(agentConfig.adapter);
    } catch (err) {
      log.error(`No adapter for "${agentConfig.adapter}": ${String(err)}`);
      messageQueue.setRunning(sessionKey, false);
      return;
    }

    // Resolve channel plugin for streaming
    const channelPlugin = channelRegistry.getByInstance(
      session.lastRoute.channel,
      session.lastRoute.accountId,
    );

    const canStream = channelPlugin?.capabilities.streaming && channelPlugin.editMessage;
    let streamer: ResponseStreamer | null = null;

    if (canStream && channelPlugin) {
      streamer = new ResponseStreamer(channelPlugin, session.lastRoute);
      try {
        await streamer.start();
      } catch (err) {
        log.warn(`Failed to start streamer: ${String(err)}`);
        streamer = null;
      }
    }

    events.emit("agent.start", {
      agentId: resolveAgent(primaryMsg, config.routing),
      adapter: agentConfig.adapter,
      sessionKey,
    }, sessionKey);

    const abortController = messageQueue.getAbortController(sessionKey);

    try {
      const result = await dispatchToAgent({
        msg: { ...primaryMsg, text: combinedText },
        session,
        agentConfig,
        adapter,
        onStreamEvent: (event: StreamEvent) => {
          events.emit("agent.event", event as unknown as Record<string, unknown>, sessionKey);
          if (streamer && event.type === "assistant") {
            streamer.appendText(event.text);
          }
        },
        onSystemEvent: (sessionId, model) => {
          if (sessionId) {
            session.sessionParams = { ...session.sessionParams, sessionId };
          }
          if (model) {
            session.model = model;
          }
        },
        signal: abortController?.signal,
      });

      // Update session from result
      if (result.clearSession) {
        session.sessionParams = null;
      } else if (result.sessionParams) {
        session.sessionParams = result.sessionParams;
      }
      session.lastActivityAt = Date.now();
      sessionStore.set(sessionKey, session);
      await sessionStore.persist();

      events.emit("agent.complete", {
        sessionKey,
        exitCode: result.exitCode,
        summary: result.summary,
        errorMessage: result.errorMessage,
      }, sessionKey);

      // Write assistant transcript
      if (result.summary) {
        await transcript.append(sessionKey, {
          role: "assistant",
          text: result.summary,
          channel: session.lastRoute.channel,
          ts: Date.now(),
        });
      }

      // Route reply
      const replyText = result.summary ?? "";
      if (replyText) {
        if (streamer) {
          await streamer.finalize(replyText);
        }

        // Special case: cron channel with replyTo
        const rawMsg = primaryMsg.raw as Record<string, unknown> | undefined;
        const replyTo = rawMsg?.replyTo as { channel: string; target: string; accountId?: string } | undefined;

        if (primaryMsg.channel === "cron" && replyTo) {
          const replyPlugin = channelRegistry.getByInstance(replyTo.channel, replyTo.accountId);
          if (replyPlugin) {
            const sendResult = await replyPlugin.send({
              channel: replyTo.channel,
              accountId: replyTo.accountId,
              target: replyTo.target,
              text: replyText,
            });
            events.emit("message.outbound", {
              channel: replyTo.channel,
              target: replyTo.target,
              ok: sendResult.ok,
              error: sendResult.error ?? null,
            }, sessionKey);
          }
        } else if (!streamer) {
          // Non-streaming: send full reply via reply router
          await routeReply(replyText, undefined, session, channelRegistry, events);
        }
      }
    } catch (err) {
      log.error(`Dispatch error for ${sessionKey}: ${String(err)}`);
      events.emit("agent.complete", {
        sessionKey,
        errorMessage: String(err),
      }, sessionKey);

      if (streamer) {
        streamer.dispose();
      }

      // Send error message to channel if possible
      if (channelPlugin) {
        try {
          await channelPlugin.send({
            channel: session.lastRoute.channel,
            target: session.lastRoute.target,
            threadId: session.lastRoute.threadId,
            text: `Error: ${String(err)}`,
          });
        } catch {
          // Best effort
        }
      }
    }

    messageQueue.setRunning(sessionKey, false);

    // Check for more queued messages
    const nextMsg = messageQueue.dequeue(sessionKey);
    if (nextMsg) {
      // Re-enqueue and dispatch (dequeue already removed it, so enqueue it back)
      const nextMessages = Array.isArray(nextMsg) ? nextMsg : [nextMsg];
      for (const m of nextMessages) {
        messageQueue.enqueue(sessionKey, m, config.queue.mode, config.queue);
      }
      await dispatchNext(sessionKey, agentConfig, session);
    }
  }

  // ----- Hook wiring -----
  function wireHooks(): void {
    if (!config.hooks) return;
    for (const [eventType, hookConfig] of Object.entries(config.hooks)) {
      events.on(eventType, (payload) => {
        executeHook(hookConfig, payload, log);
      });
    }
  }

  // ----- Gateway object -----
  const gateway: Gateway = {
    get config() {
      return config;
    },
    get events() {
      return events;
    },

    async start() {
      if (started) throw new Error("Gateway is already started");

      // Check for unsupported auth mode
      if (config.gateway.auth.mode === "password") {
        throw new Error(
          "Password auth is not yet implemented. Use auth.mode: 'token' or 'none'.",
        );
      }

      // 1. Ensure state directory exists
      await mkdir(stateDir, { recursive: true });
      await mkdir(resolve(stateDir, "sessions"), { recursive: true });

      // 2. Load persisted sessions
      await sessionStore.load();

      // 3. Create HTTP server
      const bindAddress =
        config.gateway.bind === "loopback"
          ? "127.0.0.1"
          : config.gateway.bind === "lan"
            ? "0.0.0.0"
            : config.gateway.bind;

      server = createServer();

      // 4. Mount control API routes
      mountControlRoutes(server, {
        channelRegistry,
        sessionStore: sessionStore as any,
        pairingStore: pairingStore as any,
        config: config as unknown as Record<string, unknown>,
        authToken: config.gateway.auth.mode === "token" ? config.gateway.auth.token : undefined,
      });

      // 5. Mount WebSocket
      wsHandle = mountWebSocket(
        server,
        events,
        config.gateway.auth.mode === "token" ? config.gateway.auth.token : undefined,
      );

      // 6. Start HTTP server
      await new Promise<void>((resolve, reject) => {
        server!.listen(config.gateway.port, bindAddress, () => resolve());
        server!.on("error", reject);
      });

      log.info(`Gateway listening on ${bindAddress}:${config.gateway.port}`);

      // 7. Register built-in channels
      for (const channelName of Object.keys(config.channels)) {
        if (channelName in BUILT_IN_CHANNELS) {
          try {
            const loader = BUILT_IN_CHANNELS[channelName]!;
            const mod = await loader();
            channelRegistry.register(mod.default);
          } catch (err) {
            log.error(`Failed to load built-in channel "${channelName}": ${String(err)}`);
          }
        }
      }

      // 8. Register custom channels
      if (opts.channels) {
        for (const plugin of opts.channels) {
          channelRegistry.register(plugin);
        }
      }

      // 9. Start all channels
      await channelRegistry.startAll(config.channels, {
        onMessage: handleInboundMessage,
        log,
        httpServer: server!,
      });

      // 10. Start reaper
      if (config.sessions.resetOnIdle) {
        reaper = new IdleSessionReaper(
          sessionStore,
          config.sessions.resetOnIdle,
          events,
        );
        reaper.start();
      }

      // 11. Wire hooks
      wireHooks();

      // 12. Register signal handlers
      sigintHandler = () => {
        gateway.stop().then(() => process.exit(0)).catch(() => process.exit(1));
      };
      sigtermHandler = sigintHandler;
      process.once("SIGINT", sigintHandler);
      process.once("SIGTERM", sigtermHandler);

      started = true;
    },

    async stop() {
      if (!started) return;

      // 1. Stop reaper
      if (reaper) {
        reaper.stop();
        reaper = null;
      }

      // 2. Stop all channels
      await channelRegistry.stopAll();

      // 3. Drain message queues
      messageQueue.drainAll();

      // 4. Close WebSocket connections
      if (wsHandle) {
        wsHandle.closeAll();
        wsHandle = null;
      }

      // 5. Close HTTP server
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }

      // 6. Persist final session state
      await sessionStore.persist();

      // 7. Deregister signal handlers
      if (sigintHandler) {
        process.removeListener("SIGINT", sigintHandler);
        sigintHandler = null;
      }
      if (sigtermHandler) {
        process.removeListener("SIGTERM", sigtermHandler);
        sigtermHandler = null;
      }

      started = false;
      log.info("Gateway stopped");
    },
  };

  return gateway;
}
