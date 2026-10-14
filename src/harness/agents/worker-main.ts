import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../broker/client.ts";
import { modelConfigFromEnv } from "./model.ts";
import { runResearchTrial } from "./research-worker.ts";
import type { AnyTrial } from "./spawn.ts";
import { runTrial, type TrialSpec } from "./worker.ts";

/**
 * A worker trial in its own process (one per trial), started by the controller. It reaches the
 * harness only through the local API with the proposer token, and acts in the lane's workspace
 * only through the broker. Prints the trial result as the last line of stdout.
 */
async function main(): Promise<void> {
  const trial = JSON.parse(readFileSync(String(process.argv[2]), "utf8")) as AnyTrial;
  const model = modelConfigFromEnv();
  if (!model)
    throw new Error("no model route configured (QWEN_BASE_URL, QWEN_MODEL, QWEN_API_KEY)");
  const api = process.env.THERMITE_HARNESS_URL ?? "http://127.0.0.1:8700";
  const token = process.env.THERMITE_PROPOSER_TOKEN ?? "";
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
  const runner = new BrokerClient(String(process.env.THERMITE_BROKER_SOCKET));
  const laneTool = [process.execPath, fileURLToPath(new URL("./lanetool.js", import.meta.url))];
  const result = await runTrial(spec, {
    runner,
    laneTool,
    model,
    submit: (req) => call("POST", "/v1/attempts", req),
    status: (id) => call("GET", `/v1/attempts/${id}`),
    devRun: (req) =>
      call("POST", "/v1/dev-runs", {
        lane: req.lane,
        command: req.command,
        timeout_s: req.timeoutS,
        cwd: spec.workspace,
      }),
  });
  runner.close();
  process.stdout.write(`\n${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  process.stdout.write(
    `\n${JSON.stringify({ stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, error: String(err) })}\n`,
  );
  process.exit(0);
});
