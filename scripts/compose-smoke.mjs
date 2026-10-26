#!/usr/bin/env node
// Local compose smoke test: build and start control and one rig, assign the smoke campaign
// through control, submit one candidate as a proposer, and wait until its verdict reaches
// control. Usage: COMPOSE="podman compose" node scripts/compose-smoke.mjs (or "docker compose").
import {
  assign,
  candidatePatch,
  control,
  dc,
  events,
  latestVerdicts,
  prepare,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const composeEnv = { THERMITE_POLL_SECONDS: "3", THERMITE_CALIBRATION_BLOCKS: "0" };
const env = prepare();
console.log("compose: build and start");
dc(composeEnv, "up", "-d", "--build");
try {
  await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);
  await assign(env, "smoke-1");
  console.log("assign_campaign delivered and accepted");
  const a = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/noop"),
    "rename the accumulator",
  );
  console.log("submitted", a.attempt, a.lifecycle);
  const verdict = await until(
    "verdict at control",
    async () => latestVerdicts(await events())[a.attempt],
    300_000,
    2000,
  ).catch(async (err) => {
    // What the rig had done, for a failure that says why: its newest events at control and the
    // harness's last log lines.
    const evs = await events().catch(() => []);
    for (const e of evs.slice(-25))
      console.log("event:", e.at, e.kind, JSON.stringify(e.body ?? {}).slice(0, 300));
    try {
      console.log(dc(composeEnv, "logs", "--tail", "60", "harness"));
    } catch {
      // The logs are for the reader only: the failure below is the result.
    }
    throw err;
  });
  const kinds = [...new Set((await events()).map((e) => e.kind))];
  console.log("events at control:", kinds.join(", "));
  console.log("verdict:", verdict);
  console.log("compose smoke: OK");
} finally {
  if (process.env.KEEP !== "1") dc(composeEnv, "down", "-v");
}
