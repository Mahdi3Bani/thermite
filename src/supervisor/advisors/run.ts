import type { z } from "zod";
import type { AdvisorCall, AdvisorResult } from "./call.ts";
import { runClaudeCode, runCli, runCliHarness, runPi } from "./runtimes/index.ts";

/**
 * Runs one advisor call: a role prompt, the tools, and an output schema. The model answers by
 * calling `answer` with an object that must match the schema. In Pi a refused answer is asked
 * again with its problems, until the same problems come back SAME_REFUSALS times running.
 */
export async function runAdvisor<S extends z.ZodType>(
  input: AdvisorCall<S>,
): Promise<AdvisorResult<z.infer<S>>> {
  const rt = input.runtime;
  if (rt.runtime === "cli")
    return runCli(rt, input.system, input.prompt, input.schema, input.answerSchema);
  if (rt.runtime === "claude-code") return runClaudeCode(rt, input);
  if (rt.runtime === "opencode" || rt.runtime === "codex") return runCliHarness(rt, input);
  return runPi(rt, input);
}
