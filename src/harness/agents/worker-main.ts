import { readFileSync } from "node:fs";
import type { Runner, RunOutcome, RunRequest } from "../broker/runner.ts";
import { modelConfigFromEnv } from "./model.ts";
import { runResearchTrial } from "./research-worker.ts";
import type { AnyTrial } from "./spawn.ts";
import { runTrial, type TrialSpec } from "./worker.ts";

/**
 * A worker trial in its own process (one per trial), run as its lane's agent user. It reaches
 * the harness only through the local API with its trial's own token (which binds every call to
 * the trial's instance and lane, and stops working when the trial ends). Its file and shell
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
    throw new Error("no model route configured (QWEN_BASE_URL, QWEN_MODEL, QWEN_API_KEY)");
  const api = process.env.THERMITE_HARNESS_URL ?? "http://127.0.0.1:8700";
  const token = `trial.${trial.spec.token ?? ""}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };
  if (trial.kind === "research") {
    const result = await runResearchTrial(trial.spec, {
      model,
      call: (op, args) => call("POST", `/v1/research/${op}`, args),
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
  });
  process.stdout.write(`\n${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  process.stdout.write(
    `\n${JSON.stringify({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, error: String(err) })}\n`,
  );
  process.exit(0);
});
