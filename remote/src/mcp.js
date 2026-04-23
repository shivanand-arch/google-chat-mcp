// MCP over HTTP (Streamable HTTP transport, stateless JSON mode).
// Each POST /mcp carries one JSON-RPC request; we return one JSON-RPC response.
// Bearer token resolves to a session with Google credentials.

import { TOOLS, callTool } from "./tools.js";
import { storage } from "./storage.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "google-chat", version: "0.5.0" };

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function createMcpHandler({ googleClientId, googleClientSecret }) {
  return async function mcpHandler(req, res) {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${req.protocol}://${req.get("host")}/.well-known/oauth-protected-resource"`);
      return res.status(401).json(jsonRpcError(null, -32001, "Missing bearer token"));
    }
    const token = storage.getAccessToken(match[1]);
    if (!token) {
      res.setHeader("WWW-Authenticate", `Bearer error="invalid_token"`);
      return res.status(401).json(jsonRpcError(null, -32001, "Invalid or expired token"));
    }

    const msg = req.body;
    if (!msg || typeof msg !== "object") {
      return res.status(400).json(jsonRpcError(null, -32700, "Parse error"));
    }
    const { id, method, params } = msg;

    try {
      if (method === "initialize") {
        const clientVersion = params?.protocolVersion || PROTOCOL_VERSION;
        return res.json(jsonRpcResult(id, {
          protocolVersion: clientVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }));
      }
      if (method?.startsWith("notifications/")) {
        return res.status(204).end();
      }
      if (method === "ping") return res.json(jsonRpcResult(id, {}));
      if (method === "tools/list") return res.json(jsonRpcResult(id, { tools: TOOLS }));
      if (method === "resources/list") return res.json(jsonRpcResult(id, { resources: [] }));
      if (method === "prompts/list") return res.json(jsonRpcResult(id, { prompts: [] }));

      if (method === "tools/call") {
        const name = params?.name;
        const args = params?.arguments || {};
        try {
          const result = await callTool({
            name, args,
            session: token, // { google, user, cache? }
            googleClientId, googleClientSecret,
          });
          return res.json(jsonRpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          }));
        } catch (err) {
          return res.json(jsonRpcResult(id, {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          }));
        }
      }

      return res.json(jsonRpcError(id, -32601, `Method not found: ${method}`));
    } catch (err) {
      return res.status(500).json(jsonRpcError(id, -32603, err.message));
    }
  };
}
