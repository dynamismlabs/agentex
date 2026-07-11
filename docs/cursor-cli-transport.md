# Cursor CLI transport decision

## Status

Accepted for `@agentex/agent` 0.0.28.

## Decision

Cursor remains a bespoke exec-backed provider until Cursor publishes a stable
persistent or ACP transport. One agentex `session.send()` starts one
`cursor-agent -p --output-format stream-json` process. Once the process emits a
validated `system:init`, agentex accepts its output and promotes its session ID
into `--resume` on the next send.

Grok is not a separate agentex provider. Cursor owns its provider routing and
model availability. Agentex returns the installed Cursor model catalog exactly
as discovered, so Grok appears as a Cursor model when the CLI and account expose
it.

## Safety rules

1. The supported protocol profile is `cursor-stream-json-system-init-v1`.
2. Raw output and normalized events remain quarantined until `system:init`.
3. A semantic event before acceptance degrades the protocol profile and no
   quarantined output is emitted.
4. A failed unknown-session resume may retry once without `--resume`, but only
   before acceptance.
5. Agentex never retries or rolls over after acceptance because tool effects may
   already have occurred.
6. A zero exit without the acceptance marker is not success. It is
   `protocol_degraded`.
7. Modes and model discovery are exposed only after feature probes succeed.
8. `OPENAI_API_KEY` is not Cursor authentication. API billing requires
   `CURSOR_API_KEY`; otherwise native `cursor-agent status` determines login.

## Consequences

- Multi-turn use is durable at the provider-session level but not a persistent
  child process.
- Per-turn process startup is expected.
- Permissions and structured questions cannot be bridged until Cursor exposes
  a documented protocol for them.
- Model or mode changes create a fresh host chat because the exec-backed adapter
  does not claim in-session mutation.
- If Cursor later ships ACP, the provider can move to the shared ACP base after
  its session, permission, and model semantics are verified.
