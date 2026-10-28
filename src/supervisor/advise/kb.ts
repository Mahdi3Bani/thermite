import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AdvisorsConfig, AdvisorTools } from "../advisors.ts";

/** One knowledge base's search over MCP, read only; the token is a bearer header, never in the URL. */
function mcpSearch(url: string, token: () => string, tool: string) {
  return async (query: string) => {
    const client = new Client({ name: "thermite-supervisor", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token()}` } },
      }),
    );
    try {
      const r = await client.callTool({ name: tool, arguments: { query } });
      return r.content;
    } finally {
      await client.close();
    }
  };
}

/** The knowledge-base search of the advisors file's own `kb`, read only; none without one. */
export function kbSearchFor(cfg: Pick<AdvisorsConfig, "kb">): AdvisorTools["kbSearch"] {
  const kb = cfg.kb;
  return kb
    ? mcpSearch(kb.mcp_url, () => readFileSync(kb.token_file, "utf8").trim(), kb.tool)
    : undefined;
}
