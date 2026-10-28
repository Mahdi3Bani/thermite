#!/usr/bin/env node
// Local compose smoke test: build and start control and one rig, assign the smoke campaign
// through control, submit one candidate as a proposer, and wait until its verdict reaches
// control. Usage: COMPOSE="podman compose" node scripts/acceptance/compose-smoke.mjs (or "docker compose").
//
// With THERMITE_NATS_URL=nats://nats:4222, the stack runs with the `bus` profile and the
// supervisor sends its reports and live lines over the message bus (goal 168): the smoke then
// checks that they reached control that way. Either way it prints how long events took to reach
// control.
import {
  api,
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

const bus = process.env.THERMITE_NATS_URL ?? "";
const composeEnv = {
  THERMITE_POLL_SECONDS: "3",
  THERMITE_CALIBRATION_BLOCKS: "0",
  THERMITE_NATS_URL: bus,
};
const profile = bus ? ["--profile", "bus"] : [];
const stack = (...args) => dc(composeEnv, ...profile, ...args);

/**
 * Seconds from each event's time at the rig to control holding it, from control's own store, for
 * the events from the run's start on (the rig's start waits for its first report). Both times are
 * from the same machine's clock.
 */
function eventDelays() {
  const read = `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/var/lib/thermite-control/control.db",{readOnly:true});process.stdout.write(JSON.stringify(db.prepare("select kind, at, received_at from rig_event where rig = 'local-1' order by seq").all()))`;
  const rows = JSON.parse(stack("exec", "-T", "control", "node", "-e", read));
  const start = rows.findIndex((r) => r.kind === "run_created");
  return rows
    .slice(Math.max(0, start))
    .map((r) => (Date.parse(r.received_at) - Date.parse(r.at)) / 1000)
    .sort((a, b) => a - b);
}

/** The reports stream and control's consumer of it, from the NATS server's own monitoring. */
function busState() {
  const url = "http://127.0.0.1:8222/jsz?streams=true&consumers=true";
  const jsz = JSON.parse(stack("exec", "-T", "nats", "wget", "-q", "-O", "-", url));
  const stream = (jsz.account_details ?? [])
    .flatMap((a) => a.stream_detail ?? [])
    .find((s) => s.name === "REPORTS");
  const consumer = (stream?.consumer_detail ?? []).find((c) => c.name === "control-reports");
  return {
    messages: stream?.state?.messages ?? 0,
    lastSeq: stream?.state?.last_seq ?? 0,
    ackedTo: consumer?.ack_floor?.stream_seq ?? 0,
    pending: (consumer?.num_pending ?? 0) + (consumer?.num_ack_pending ?? 0),
  };
}

const env = prepare();
console.log(`compose: build and start (reports over ${bus ? "the message bus" : "HTTP"})`);
stack("up", "-d", "--build");
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
      console.log(stack("logs", "--tail", "60", "harness"));
    } catch {
      // The logs are for the reader only: the failure below is the result.
    }
    throw err;
  });
  const kinds = [...new Set((await events()).map((e) => e.kind))];
  console.log("events at control:", kinds.join(", "));
  console.log("verdict:", verdict);
  if (bus) {
    // The reports came over the bus: the stream holds them, and control acked each one it folded.
    const state = await until(
      "control folded every report on the bus",
      async () => {
        const s = busState();
        return s.messages > 0 && s.pending === 0 && s.ackedTo === s.lastSeq ? s : undefined;
      },
      60_000,
      1000,
    );
    console.log("reports on the bus:", JSON.stringify(state));
    // The live lines came over the bus too: control's state of the bus says it took them, and the
    // supervisor's figures say it published them.
    const live = await until(
      "live lines over the bus",
      async () => {
        const { body } = await api("/v1/bus");
        const rig = body.live?.rigs?.find((r) => r.rig === "local-1");
        const stream = body.streams?.find((x) => x.name === "LIVE");
        return stream?.messages > 0 && rig?.taken > 0 && rig?.supervisor?.published > 0
          ? { messages: stream.messages, taken: body.live.taken, rig }
          : undefined;
      },
      60_000,
      1000,
    );
    console.log("live lines on the bus:", JSON.stringify(live));
  }
  const delays = eventDelays();
  const at = (q) => delays[Math.min(delays.length - 1, Math.floor(q * delays.length))] ?? 0;
  console.log(
    `seconds from an event to control holding it, over ${bus ? "the bus" : "HTTP"} (${delays.length} events): median ${at(0.5).toFixed(2)}, 90th percentile ${at(0.9).toFixed(2)}, max ${(delays.at(-1) ?? 0).toFixed(2)}`,
  );
  console.log("compose smoke: OK");
} finally {
  if (process.env.KEEP !== "1") stack("down", "-v");
}
