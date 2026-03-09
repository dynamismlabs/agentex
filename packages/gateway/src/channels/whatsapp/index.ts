import { defineChannel } from "../define.js";

export default defineChannel({
  id: "whatsapp",
  label: "WhatsApp",
  capabilities: {
    chatTypes: ["direct", "group"],
    streaming: false,
    maxMessageLength: 65536,
  },

  async start() {
    throw new Error(
      "WhatsApp channel is not yet fully implemented. " +
        "Install @whiskeysockets/baileys and contribute the integration, " +
        "or use a different channel.",
    );
  },

  async stop() {
    // No-op
  },

  async status() {
    return { ok: false, error: "Not implemented" };
  },

  async send() {
    throw new Error("WhatsApp channel send is not yet implemented");
  },
});
