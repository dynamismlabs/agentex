import { createInterface } from "node:readline";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "agentex-mcp-test", version: "1" } });
  else if (msg.method === "tools/list") send(msg.id, { tools: [{ name: "echo", description: "Read-only local test", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] });
  else if (msg.method === "tools/call") send(msg.id, { content: [{ type: "text", text: process.env.AGENTEX_MCP_TEST_VALUE ?? "missing" }], structuredContent: { pid: process.pid } });
  else send(msg.id, {});
}).on("close", () => process.exit(0));
