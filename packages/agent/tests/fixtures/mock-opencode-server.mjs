import { createServer } from "node:http";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const expected = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
const server = createServer((request, response) => {
  if (request.headers.authorization !== expected) {
    response.writeHead(401).end("unauthorized");
    return;
  }
  if (request.url === "/global/health") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ healthy: true }));
    return;
  }
  response.writeHead(404).end("not found");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") {
    console.log(`listening on http://127.0.0.1:${address.port}`);
  }
});

process.on("SIGTERM", () => {
  if (process.env.MOCK_IGNORE_SIGTERM === "1") return;
  server.close(() => process.exit(0));
});
