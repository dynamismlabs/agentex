# Turn liveness and nested actors (Claude)

## The symptom

An execution shows "needs response" while the agent is plainly still working.
The visible reply changes several times in a row, cycling through messages the
agent never addressed to the user.

## What is actually happening

Three independent facts about the Claude Code wire, none of them obvious, all
observed live on 2.1.241.

**1. A subagent's output is streamed onto the parent session.** When the agent
launches a subagent, that child's assistant text, thinking, and tool calls all
arrive on the parent's stream, each tagged with the `tool_use` id of the call
that launched it. This mirrors Claude's own on-disk model, where the subagent
gets its own transcript file and the parent's contains none of it. Drop the tag
and a child talking to its caller is indistinguishable from the session
answering the user.

**2. Claude starts turns by itself.** Launching a background task ends the root
turn. When that task finishes, the CLI enqueues its result as user input, which
opens a fresh turn with no host involvement. One user message can therefore
produce several turns, minutes apart.

The load-bearing detail: **a host message carries a uuid and a
provider-initiated continuation does not.** Every dequeued input with a uuid
emits `command_lifecycle` (queued → started → completed) naming it; the
task-notification continuation is enqueued without one and emits nothing. So
"named by the CLI = the host's turn, everything else = provider-initiated" is
an exact reading of the protocol, not a heuristic. That single fact is why the
design works.

**3. One task completion is reported as two different records.** A state patch
(`task_updated`, "this task is now complete") and a result delivery
(`task_notification`, "here is what it produced"). They arrive at the same
instant and look identical once normalized, but only the delivery carries the
summary and the `tool_use` id linking the task to its launch.

## Why a host cannot see this

A host tracks "is the agent working" from its own `send()`. Fact 2 means not
every turn is the host's, and the API exposed no way to observe one it did not
start. So `send()` resolves, the host reports finished, and the agent keeps
working for another ten minutes.

Fact 1 compounds it: every subagent line looked like a fresh reply, so the
visible answer churned and the session re-marked itself unread continuously.

## The fix, as three ideas

**Keep the attribution.** Store which tool call produced each event. Subagent
output then renders inside the call that launched it, never as the session's
reply, and never counts as output the user is waiting on. Purely a host-side
change; the library was already forwarding the tag.

**Make turn liveness observable.** Emit `turn_start` and `turn_end` around
every turn, so "is it working" is read off the stream instead of inferred from
dispatch. `result` stays the outcome payload rather than doubling as the close
signal, because a message the CLI cancels, discards, or refuses opens a turn
and produces no result at all — a host pairing `turn_start` with `result` would
wait forever on those.

Host turns are identified exactly: the CLI echoes back the uuid the send
generated, so a turn naming an outstanding message *is* that message's turn. A
turn owns a *set* of those, not one, because the CLI coalesces — a second
message dequeued mid-turn joins the running turn rather than starting its own.

**Stop collapsing the two completion records.** Mark which one actually
delivered the result, and carry the tool-call link that only it has. One row
per completion, and the task-to-launch relationship survives.

## Accepted trade-offs

**Turn-open is a whitelist, and it fails toward false-idle.** A turn closes on
`result` or on a terminal `command_lifecycle`, both explicit. A turn *opens* on
a recognized set of line types, so a wire type we do not recognize opens
nothing and the session reads idle while working — the original bug, in a
narrower form.

This is the residual risk of the design and it is worth stating plainly rather
than dressing up. It is mitigated by breadth (`assistant`, `user`, `tool_use`,
`stream_event`, and `command_lifecycle/started` between them cover every turn
head observed live) and by the fact that a missed opener is recoverable — the
next recognized line opens the turn late rather than never. The opposite
mistake, treating scaffolding as an opener, produces a turn that never closes,
which is why the list is an allowlist rather than a denylist.

**`system/init` is a latency optimization, not the correctness guarantee.** It
heads every provider-initiated turn and precedes that turn's first content by
1.4-2.2s, so opening on it buys the head of the turn. Content lines open the
turn regardless, so losing the init opener degrades latency rather than
breaking liveness. It only opens a turn after the first `result`, which is what
separates a resume header from boot metadata.

## What we deliberately did not do

- **No grace periods or debounce.** Liveness is derived from what the stream
  says, not from waiting to see if more arrives.
- **Background tasks do not gate "done".** A finished main agent reads as
  finished even with work still running, matching the CLI. A dev server left
  running in the background would otherwise pin a session as busy forever.
- **`turn_start` does not name the task behind a resume.** Claude delivers a
  task's result and opens the turn as two unlinked records; with several tasks
  in flight the pairing is not recoverable. Every attempt to infer it produced
  a plausible id that was sometimes wrong. Correlate through the delivery
  record instead, which the provider does state.

## Why this was larger than it looks

The three facts are simple. The trap is that each one invites you to invent
bookkeeping to approximate something the protocol either states exactly or does
not state at all. Counting outstanding sends approximates a correlation the
wire gives you verbatim. Remembering "the task that will cause the next resume"
approximates a link that does not exist.

Every approximation looked right, passed tests, and failed on a case nobody had
thought of yet — a cancelled message, two subagents finishing together, a
result and the next turn arriving in one chunk. The first resolution was to
replace invented state with the wire's own identifiers, and to delete the one
feature the wire cannot support.

That was necessary and not sufficient. The identifiers were then still held in
mutable fields updated across `await` boundaries, and the same class of bug
kept appearing in a new place each review: a settlement list shared by every
turn, so whichever handler resumed first drained all of it; single-valued
fields where the domain has sets. The second resolution was structural — turn,
command, and task state reduced from the ordered wire, with each turn's
settlement batch captured synchronously before any suspension point. The tests
changed shape too: permutation and invariant tests over the state machine,
because a suite of one-test-per-past-bug passed while two races were live.
