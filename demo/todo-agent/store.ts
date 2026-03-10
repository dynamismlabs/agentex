import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DATA_FILE = join(DATA_DIR, "todos.json");

export interface Todo {
  id: string;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "failed";
  createdAt: string;
  completedAt: string | null;
  agentType: "claude" | "codex" | null;
  runId: string | null;
  agentResult: {
    exitCode: number | null;
    summary: string | null;
    costUsd: number | null;
    model: string | null;
    errorMessage: string | null;
    durationMs: number;
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
  } | null;
}

export function readTodos(): Todo[] {
  if (!existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeTodos(todos: Todo[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(todos, null, 2));
}

export function getTodo(id: string): Todo | undefined {
  return readTodos().find((t) => t.id === id);
}

export function addTodo(title: string, description: string): Todo {
  const todos = readTodos();
  const todo: Todo = {
    id: `todo_${Date.now()}`,
    title,
    description,
    status: "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    agentType: null,
    runId: null,
    agentResult: null,
  };
  todos.push(todo);
  writeTodos(todos);
  return todo;
}

export function updateTodo(id: string, patch: Partial<Todo>): Todo | null {
  const todos = readTodos();
  const idx = todos.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const existing = todos[idx];
  if (!existing) return null;
  const updated: Todo = { ...existing, ...patch };
  todos[idx] = updated;
  writeTodos(todos);
  return updated;
}

export function deleteTodo(id: string): boolean {
  const todos = readTodos();
  const filtered = todos.filter((t) => t.id !== id);
  if (filtered.length === todos.length) return false;
  writeTodos(filtered);
  return true;
}

export function clearTodos(): void {
  writeTodos([]);
}

interface SeedTodo {
  title: string;
  description: string;
  files?: Record<string, string>;
}

const SEED_TODOS: SeedTodo[] = [
  // --- Coding tasks ---
  {
    title: "Write a fizzbuzz function",
    description: "Create a file fizzbuzz.ts that prints numbers 1-100, replacing multiples of 3 with Fizz, 5 with Buzz, and both with FizzBuzz.",
  },
  {
    title: "Create a simple HTTP server",
    description: "Write a minimal Node.js HTTP server in server.ts that responds with JSON { \"status\": \"ok\", \"timestamp\": \"<ISO date>\" } on GET /health.",
  },
  {
    title: "Implement a stack data structure",
    description: "Create stack.ts with a generic Stack<T> class supporting push, pop, peek, isEmpty, and size. Include a few basic tests.",
  },
  {
    title: "Write a markdown-to-HTML converter",
    description: "Create md2html.ts that converts a subset of markdown (headings, bold, italic, links, code blocks) to HTML. No external dependencies.",
  },
  {
    title: "Build a CLI calculator",
    description: "Create calc.ts that takes a math expression as a CLI argument (e.g. '2 + 3 * 4') and prints the result. Support +, -, *, /, and parentheses.",
  },
  // --- Non-coding tasks ---
  {
    title: "Analyze quarterly sales data",
    description:
      "Read sales_data.csv in the current directory. Produce a report (report.md) that includes: total revenue, top 3 products by units sold, month-over-month growth, and any notable trends. Include a summary table.",
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
    title: "Research briefing: local-first software",
    description:
      "Write a research briefing (briefing.md) on the local-first software movement. Cover: what it is and why it matters, key technologies (CRDTs, sync engines), major projects and companies in the space, trade-offs vs traditional cloud architectures, and a short outlook section. Aim for ~800 words. Cite specific projects by name.",
  },
  {
    title: "Write a product launch email",
    description:
      'Draft a product launch email (launch-email.md) for a new feature called "Smart Workflows" — an AI-powered automation builder for project management. Target audience: existing users of a B2B SaaS platform. Tone: professional but energetic. Include: subject line, preview text, hero section, 3 key benefits with short descriptions, a CTA, and a P.S. line. Output as markdown with clear section headers.',
  },
  {
    title: "Draft a blog post on AI agents in production",
    description:
      'Write a blog post (blog-post.md) titled "What We Learned Running AI Agents in Production." Write from the perspective of an engineering team that has been deploying LLM-based agents for 6 months. Cover: architecture decisions, failure modes encountered, cost management strategies, monitoring and observability, and practical tips for teams getting started. Aim for ~1000 words. Conversational but technical tone.',
  },
  {
    title: "Convert meeting transcript into action items",
    description:
      "Read transcript.md in the current directory. Extract all action items, decisions made, and open questions. Output a structured document (action-items.md) with sections: Decisions, Action Items (with owner and deadline if mentioned), Open Questions, and a one-paragraph meeting summary.",
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
];

const WORKSPACE_DIR = join(DATA_DIR, "workspace");

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function seedTodos(): Todo[] {
  const existing = readTodos();
  const seeded: Todo[] = [];
  let offset = 0;
  for (const { title, description, files } of shuffle(SEED_TODOS)) {
    const id = `todo_${Date.now() + offset}`;
    const todo: Todo = {
      id,
      title,
      description,
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
      agentType: null,
      runId: null,
      agentResult: null,
    };
    if (files) {
      const wsDir = join(WORKSPACE_DIR, id);
      mkdirSync(wsDir, { recursive: true });
      for (const [filename, content] of Object.entries(files)) {
        writeFileSync(join(wsDir, filename), content);
      }
    }
    seeded.push(todo);
    offset++;
  }
  writeTodos([...existing, ...seeded]);
  return seeded;
}
