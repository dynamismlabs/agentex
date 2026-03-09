import { defineChannel } from "../define.js";

export default defineChannel({
  id: "email",
  label: "Email",
  capabilities: {
    chatTypes: ["direct"],
    streaming: false,
  },

  async start() {
    throw new Error(
      "Email channel is not yet fully implemented. " +
        "Install imapflow and nodemailer and contribute the integration, " +
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
    throw new Error("Email channel send is not yet implemented");
  },
});
