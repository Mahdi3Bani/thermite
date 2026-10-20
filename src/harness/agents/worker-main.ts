import { readFileSync } from "node:fs";
import type { McpCallResult } from "../../common/mcp-client.ts";
import type { McpToolInfo } from "../../core/mcp.ts";
import type { Runner, RunOutcome, RunRequest } from "../broker/runner.ts";
import { apiCall } from "./api-call.ts";
import type { TrialProgress } from "./live-session.ts";
import { modelConfigFromEnv } from "./model.ts";
import { runResearchTrial } from "./research-worker.ts";
import type { AnyTrial } from "./spawn.ts";
import { type McpForAgent, runTrial, type TrialSpec } from "./worker.ts";

/**
 * A worker trial in its own process (one per trial), run as its lane's agent user. It reaches
 * the harness only through the local API with its trial's own token (which binds every call to
 * the trial's run and lane, and stops working when the trial ends). Its file and shell
 * tools run in the lane's workspace, as the lane's user, through that API: the agent itself can
 * read none of it. Prints the trial result as the last line of stdout.
 */

/** Lane work through the harness API (the harness checks it against the trial). */
class ApiLaneRunner implements Pick<Runner, "run" | "killRole"> {
  readonly separated = true;
  private readonly call: (path: string, body: unknown) => Promise<unknown>;

  constructor(call: (path: string, body: unknown) => Promise<unknown>) {
    this.call = call;
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    return (await this.call("/v1/lane/run", req)) as RunOutcome;
  }

  async killRole(): Promise<number> {
    return 0; // the harness kills the lane's processes when the trial ends
  }
}

async function main(): Promise<void> {
  const trial = JSON.parse(readFileSync(String(process.argv[2]), "utf8")) as AnyTrial;
  const model = modelConfigFromEnv();
  if (!model)
    throw new Error(
      "no model route configured (THERMITE_MODEL_BASE_URL, THERMITE_MODEL, THERMITE_MODEL_API_KEY)",
    );
  const api = process.env.THERMITE_HARNESS_URL ?? "http://127.0.0.1:8700";
  const token = `trial.${trial.spec.token ?? ""}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const { status, text } = await apiCall(
      `${api}${path}`,
      method,
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body !== undefined ? JSON.stringify(body) : undefined,
    );
    if (status < 200 || status >= 300)
      throw new Error(`${method} ${path} -> ${status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };
  // The live view: this session's turns to the live log, the owner's messages back in (each
  // confirmed once the agent has it).
  const link = {
    live: (entries: unknown[]) => call("POST", "/v1/trial/live", { entries }),
    messages: async () =>
      (
        (await call("GET", "/v1/trial/messages")) as {
          messages: { id: number; text: string }[];
        }
      ).messages,
    read: (ids: number[]) => call("POST", "/v1/trial/messages/read", { ids }),
    progress: (p: TrialProgress) => call("POST", "/v1/trial/live", { entries: [], progress: p }),
  };
  // The MCP tools the run's kit gives its workers (goal 068), as the harness's gateway lists them
  // for this trial. A list that can't be read gives none: the trial goes on with its own tools.
  let mcp: McpForAgent | undefined;
  if (trial.spec.mcpServers?.length) {
    try {
      const listed = (await call("GET", "/v1/mcp-tools")) as { tools: McpToolInfo[] };
      if (listed.tools.length)
        mcp = {
          tools: listed.tools,
          call: async (server, tool, args) =>
            (await call("POST", "/v1/mcp-call", {
              server,
              tool,
              arguments: args,
            })) as McpCallResult,
        };
    } catch (err) {
      // Said in the live view; the trial goes on with its own tools.
      await link
        .live([
          {
            kind: "status",
            text: `the MCP tools could not be listed (${String(err).slice(0, 300)}): this trial goes on without them`,
          },
        ])
        .catch(() => undefined);
    }
  }
  if (trial.kind === "research") {
    const result = await runResearchTrial(trial.spec, {
      mcp,
      model,
      call: (op, args) => call("POST", `/v1/research/${op}`, args),
      link,
      idea: (req) => call("POST", "/v1/trial/idea", req),
      note: (req) => call("POST", "/v1/trial/note", req),
    });
    process.stdout.write(`\n${JSON.stringify(result)}\n`);
    return;
  }
  const spec: TrialSpec = trial.spec;
  const runner = new ApiLaneRunner((path, body) => call("POST", path, body));
  const result = await runTrial(spec, {
    runner: runner as unknown as Runner,
    // The harness substitutes the lane tool's real argv.
    laneTool: ["lanetool"],
    model,
    submit: (req) =>
      call("POST", "/v1/attempts", {
        patch_base64: req.patch_base64,
        hypothesis: req.hypothesis,
        claim: req.claim,
        known_flaws: req.known_flaws,
      }),
    status: (id) => call("GET", `/v1/attempts/${id}`),
    devRun: (req) =>
      call("POST", "/v1/dev-runs", {
        command: req.command,
        timeout_s: req.timeoutS,
        cwd: spec.workspace,
      }),
    // An idea for the run's queue: the trial's token decides the run and the lane.
    idea: (req) => call("POST", "/v1/trial/idea", req),
    // A field note: the trial's token decides the run, the lane and who wrote it.
    note: (req) => call("POST", "/v1/trial/note", req),
    // Sources, claims and notes in the run's research folder (the trial decides the run).
    research: (op, args) => call("POST", `/v1/research/${op}`, args),
    link,
    mcp,
  });
  process.stdout.write(`\n${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  process.stdout.write(
    `\n${JSON.stringify({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, error: String(err) })}\n`,
  );
  process.exit(0);
});
