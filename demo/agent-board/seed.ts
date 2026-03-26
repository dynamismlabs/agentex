// ---------------------------------------------------------------------------
// Agent Board – Seed data generator
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  readState,
  writeState,
  DATA_DIR,
  ensureTaskMarkdown,
  WORKSPACE_DIR,
} from "./store.js";
import type { Task, Goal, Area, Decision, Note } from "./types.js";

// ---------------------------------------------------------------------------
// Seed areas
// ---------------------------------------------------------------------------

const AREAS: Area[] = [
  { id: "area-eng", name: "Engineering", color: "#3b82f6" },
  { id: "area-content", name: "Content", color: "#a855f7" },
  { id: "area-research", name: "Research", color: "#10b981" },
  { id: "area-ops", name: "Operations", color: "#f97316" },
];

// ---------------------------------------------------------------------------
// Seed goals
// ---------------------------------------------------------------------------

const GOALS: Goal[] = [
  { id: "goal-demo", title: "Ship demo features", areaId: "area-eng", status: "active", createdAt: new Date().toISOString() },
  { id: "goal-content", title: "Create content library", areaId: "area-content", status: "active", createdAt: new Date().toISOString() },
  { id: "goal-research", title: "Market research sprint", areaId: "area-research", status: "active", createdAt: new Date().toISOString() },
];

// ---------------------------------------------------------------------------
// Seed tasks
// ---------------------------------------------------------------------------

interface SeedTask {
  title: string;
  description: string;
  priority: Task["priority"];
  areaId: string;
  goalId: string | null;
  files?: Record<string, string>;
}

const SEED_TASKS: SeedTask[] = [
  {
    title: "Write a fizzbuzz function",
    description: "Create fizzbuzz.ts that prints numbers 1-100, replacing multiples of 3 with 'Fizz', multiples of 5 with 'Buzz', and multiples of both with 'FizzBuzz'. Include tests.",
    priority: "medium",
    areaId: "area-eng",
    goalId: "goal-demo",
  },
  {
    title: "Build a REST API for a bookstore",
    description: "Create a simple Express REST API (bookstore.ts) with in-memory storage. Endpoints: GET /books, GET /books/:id, POST /books, PUT /books/:id, DELETE /books/:id. Include a few seed books.",
    priority: "high",
    areaId: "area-eng",
    goalId: "goal-demo",
  },
  {
    title: "Implement a linked list in TypeScript",
    description: "Create linked-list.ts with a generic LinkedList<T> class supporting append, prepend, delete, find, toArray, and size. Include basic tests.",
    priority: "low",
    areaId: "area-eng",
    goalId: "goal-demo",
  },
  {
    title: "Write a blog post on AI agents",
    description: 'Write a blog post (blog-post.md) titled "What We Learned Running AI Agents in Production." Write from the perspective of an engineering team that has been deploying LLM-based agents for 6 months. Cover: architecture decisions, failure modes encountered, cost management strategies, monitoring and observability, and practical tips for teams getting started. Aim for ~1000 words.',
    priority: "high",
    areaId: "area-content",
    goalId: "goal-content",
  },
  {
    title: "Draft a product launch email",
    description: 'Draft a product launch email (launch-email.md) for a new feature called "Smart Workflows" — an AI-powered automation builder for project management. Target audience: existing users of a B2B SaaS platform. Include: subject line, preview text, hero section, 3 key benefits with short descriptions, a CTA, and a P.S. line.',
    priority: "medium",
    areaId: "area-content",
    goalId: "goal-content",
  },
  {
    title: "Convert meeting transcript to action items",
    description: "Read transcript.md in the current directory. Extract all action items, decisions made, and open questions. Output a structured document (action-items.md) with sections: Decisions, Action Items (with owner and deadline if mentioned), Open Questions, and a one-paragraph meeting summary.",
    priority: "critical",
    areaId: "area-ops",
    goalId: null,
    files: {
      "transcript.md": `# Product Sync — June 4, 2025

**Attendees:** Sarah (PM), Jake (Eng Lead), Maria (Design), Tom (Data)

**Sarah:** Alright, let's start. First up — the onboarding redesign. Maria, where are we?

**Maria:** The new flow mockups are done. I shared them in Figma yesterday. Main change is we collapsed the 5-step wizard into 3 steps. Cut the team invitation step from the initial flow — we'll prompt for that after they've created their first project instead.

**Jake:** I like that. Less friction upfront. I had a question though — are we keeping the SSO setup in onboarding or moving that to settings?

**Maria:** I'd say move it to settings. Only about 15% of new signups are on enterprise plans anyway.

**Sarah:** Agreed. Let's move SSO to settings. Jake, how long to implement the new flow?

**Jake:** If the API contracts stay the same, probably two sprints. I'll need to sync with the backend team on the new project creation endpoint though. The current one doesn't support the template parameter Maria's design needs.

**Sarah:** Can you set up that sync this week?

**Jake:** Yeah, I'll grab time with Priya tomorrow.

**Tom:** Quick data point — I looked at our funnel metrics. We're losing 34% of users between step 3 and step 4 in the current flow. That's the team invitation step. So Maria's instinct to defer it is backed by the numbers.

**Sarah:** Great, that validates the decision. Tom, can you set up tracking for the new flow so we can compare?

**Tom:** Sure. I'll have the event spec ready by Friday.

**Sarah:** Next topic — the API rate limiting issue. Jake?

**Jake:** Yeah, we had three incidents last week where a single customer's webhook integration was hitting our API at 2000 requests per minute. Our current limit is 500/min but it's not enforced on the webhook callback endpoint.

**Sarah:** That's a gap. What's the fix?

**Jake:** Two things. Short term — extend rate limiting to all endpoints, including webhooks. I can ship that this week. Long term — we need a proper API gateway. I'd like to propose we evaluate Kong or similar for Q3.

**Sarah:** Ship the short-term fix ASAP. For the gateway — write up a one-pager with requirements and cost estimate and let's review it at next week's meeting.

**Jake:** Will do.

**Maria:** On a related note — should we add rate limit info to the API docs? Customers keep asking in support tickets.

**Sarah:** Yes, definitely. Maria, can you work with Jake on the copy for that?

**Maria:** Sure, I'll draft something next week once the new limits are finalized.

**Sarah:** Last thing — the Q3 planning offsite. We're confirmed for July 15-16. I'll send calendar invites today. Come with your team's top 3 priorities. That's it — anything else?

**Tom:** One thing — the data pipeline migration to the new warehouse is 80% done. Should be complete by end of next week. No action needed, just FYI.

**Sarah:** Thanks Tom. Alright, we're done. Thanks everyone.`,
    },
  },
  {
    title: "Research local-first software movement",
    description: "Write a research briefing (briefing.md) on the local-first software movement. Cover: what it is and why it matters, key technologies (CRDTs, sync engines), major projects and companies in the space, trade-offs vs traditional cloud architectures, and a short outlook section. Aim for ~800 words.",
    priority: "high",
    areaId: "area-research",
    goalId: "goal-research",
  },
  {
    title: "Analyze quarterly sales data",
    description: "Read sales_data.csv in the current directory. Produce a report (report.md) that includes: total revenue, top 3 products by units sold, month-over-month growth, and any notable trends. Include a summary table.",
    priority: "medium",
    areaId: "area-research",
    goalId: "goal-research",
    files: {
      "sales_data.csv": [
        "month,product,units_sold,unit_price,region",
        "2025-01,Widget A,1200,29.99,North America",
        "2025-01,Widget B,850,49.99,North America",
        "2025-01,Widget C,340,99.99,Europe",
        "2025-01,Service Plan,180,199.99,North America",
        "2025-02,Widget A,1350,29.99,North America",
        "2025-02,Widget B,920,49.99,Europe",
        "2025-02,Widget C,410,99.99,North America",
        "2025-02,Service Plan,210,199.99,Europe",
        "2025-03,Widget A,1100,29.99,Europe",
        "2025-03,Widget B,1050,49.99,North America",
        "2025-03,Widget C,525,99.99,North America",
        "2025-03,Service Plan,195,199.99,North America",
        "2025-04,Widget A,1500,29.99,North America",
        "2025-04,Widget B,780,49.99,Europe",
        "2025-04,Widget C,600,99.99,Europe",
        "2025-04,Service Plan,240,199.99,North America",
        "2025-05,Widget A,1420,29.99,Europe",
        "2025-05,Widget B,1100,49.99,North America",
        "2025-05,Widget C,580,99.99,North America",
        "2025-05,Service Plan,260,199.99,Europe",
        "2025-06,Widget A,1600,29.99,North America",
        "2025-06,Widget B,1250,49.99,North America",
        "2025-06,Widget C,620,99.99,Europe",
        "2025-06,Service Plan,290,199.99,North America",
      ].join("\n"),
    },
  },
  {
    title: "Compare TypeScript runtime options",
    description: "Write a comparison document (comparison.md) evaluating Bun, Deno, and Node.js as TypeScript runtimes. Cover: performance benchmarks (cite public data), ecosystem compatibility, developer experience, production readiness, and a recommendation with rationale.",
    priority: "low",
    areaId: "area-research",
    goalId: "goal-research",
  },
];

// ---------------------------------------------------------------------------
// Seed notes
// ---------------------------------------------------------------------------

interface SeedNote {
  title: string;
  areaId: string | null;
  content: string;
}

const SEED_NOTES: SeedNote[] = [
  {
    title: "Architecture decisions",
    areaId: "area-eng",
    content: `# Architecture Decisions

## Runtime
- TypeScript everywhere, ESM modules
- Local-first: SQLite for persistence, file system for workspace data
- No cloud dependencies for core functionality

## Agent Communication
- Process spawning (child_process) for agent execution
- Session resume via provider-specific mechanisms
- SSE for real-time streaming to frontend

## Data Model
- JSON index file as source of truth
- Markdown files for human-readable task/note history
- Workspace directories isolated per task

## Open Questions
- [ ] Should we support concurrent agent execution per workspace?
- [ ] How to handle agent memory across sessions?
- [ ] Rate limiting strategy for API-billed models
`,
  },
  {
    title: "Product launch checklist",
    areaId: "area-ops",
    content: `# Product Launch Checklist

## Pre-Launch
- [ ] Feature complete and tested
- [ ] Documentation updated
- [ ] Demo video recorded
- [ ] Blog post drafted
- [ ] Social media assets prepared

## Launch Day
- [ ] Deploy to production
- [ ] Publish blog post
- [ ] Send launch email
- [ ] Post on social media
- [ ] Monitor error rates

## Post-Launch
- [ ] Collect user feedback
- [ ] Track adoption metrics
- [ ] Plan iteration based on feedback
- [ ] Write retrospective
`,
  },
];

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

export function seedData(): { tasks: Task[]; notes: Note[]; decisions: Decision[] } {
  const state = readState();

  // Add areas (idempotent)
  state.areas = AREAS;
  state.goals = GOALS;

  // Add tasks
  const seededTasks: Task[] = [];
  let offset = 0;
  for (const seed of SEED_TASKS) {
    const now = new Date().toISOString();
    const id = `task_${Date.now() + offset}`;
    const task: Task = {
      id,
      title: seed.title,
      description: seed.description,
      status: "todo",
      priority: seed.priority,
      areaId: seed.areaId,
      goalId: seed.goalId,
      assignedAgentId: null,
      proposedByAgentId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
      modifiedFiles: [],
    };
    state.tasks.push(task);
    seededTasks.push(task);

    // Create workspace with files if needed
    if (seed.files) {
      const wsDir = join(WORKSPACE_DIR, id);
      mkdirSync(wsDir, { recursive: true });
      for (const [filename, content] of Object.entries(seed.files)) {
        writeFileSync(join(wsDir, filename), content);
      }
    }

    offset++;
  }

  // Create task markdown files
  writeState(state);
  for (const task of seededTasks) {
    ensureTaskMarkdown(task);
  }

  // Add notes
  const seededNotes: Note[] = [];
  const notesDir = join(DATA_DIR, "notes");
  mkdirSync(notesDir, { recursive: true });
  for (const seed of SEED_NOTES) {
    const id = `note_${Date.now() + offset}`;
    const file = `notes/${id}.md`;
    const now = new Date().toISOString();
    const note: Note = { id, title: seed.title, areaId: seed.areaId, file, createdAt: now, updatedAt: now };
    state.notes.push(note);
    seededNotes.push(note);
    writeFileSync(join(DATA_DIR, file), seed.content);
    offset++;
  }

  // Add seed decision
  const decId = `dec_${Date.now() + offset}`;
  const runtimeTask = seededTasks.find((t) => t.title.includes("Compare TypeScript"));
  const seedDecision: Decision = {
    id: decId,
    question: "Which TypeScript runtime should we standardize on?",
    context: "We need to pick a runtime for all new services. This affects build tooling, CI pipelines, and developer onboarding.",
    options: ["Bun", "Deno", "Node.js"],
    taskId: runtimeTask?.id ?? null,
    agentId: "agent-1",
    status: "pending",
    answer: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
  };
  state.decisions.push(seedDecision);

  writeState(state);
  return { tasks: seededTasks, notes: seededNotes, decisions: [seedDecision] };
}
