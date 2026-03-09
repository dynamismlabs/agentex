import { randomUUID } from "node:crypto";
import { defineChannel } from "../define.js";
import type { ChannelContext } from "../../types.js";

interface CronJobConfig {
  schedule: string;
  prompt: string;
  sessionKey: string;
  replyTo?: {
    channel: string;
    target: string;
    accountId?: string;
  };
  timezone?: string;
}

interface CronConfig {
  jobs: CronJobConfig[];
}

let activeJobs: Array<{ stop(): void }> = [];

export default defineChannel({
  id: "cron",
  label: "Cron Scheduler",
  capabilities: {
    chatTypes: ["direct"],
    streaming: false,
  },

  async start(ctx: ChannelContext) {
    const config = ctx.config as unknown as CronConfig;
    const jobs = config.jobs ?? [];

    // Dynamic import — cron is an optional dependency
    let CronJobClass: any;
    try {
      const cronModule = await (Function('return import("cron")')() as Promise<any>);
      CronJobClass = cronModule.CronJob;
    } catch {
      ctx.log.warn("Cron channel requires the 'cron' package. Install it with: pnpm add cron");
      throw new Error("Missing required dependency: cron");
    }

    activeJobs = [];

    for (const job of jobs) {
      const cronJob = new CronJobClass(
        job.schedule,
        () => {
          ctx.log.info(`Cron job fired: ${job.sessionKey}`);
          ctx.onMessage({
            messageId: randomUUID(),
            channel: "cron",
            senderId: "cron",
            chatType: "direct",
            target: job.sessionKey,
            text: job.prompt,
            timestamp: Date.now(),
            raw: { replyTo: job.replyTo },
          });
        },
        null,
        true,
        job.timezone,
      );
      activeJobs.push(cronJob as { stop(): void });
    }

    ctx.log.info(`Cron channel started with ${jobs.length} job(s)`);
  },

  async stop() {
    for (const job of activeJobs) {
      job.stop();
    }
    activeJobs = [];
  },

  async status() {
    return {
      ok: true,
      details: { jobCount: activeJobs.length },
    };
  },

  async send(msg) {
    // Cron is typically one-way. The gateway orchestrator handles replyTo routing.
    console.log(`[cron] Response for ${msg.target}: ${msg.text.slice(0, 100)}`);
    return { ok: true };
  },
});
