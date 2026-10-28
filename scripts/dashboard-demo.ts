// A local demo of the control dashboard with synthetic data: four rigs, a hill climb on two of
// them (promotions, a pending approval, an audit hold, a cross-verified champion), a goal
// campaign part way, a research campaign, and a stale rig. For working on the dashboard only.
//
//   node --experimental-strip-types scripts/dashboard-demo.ts [--port 8810]
//   then open http://127.0.0.1:8810/ui and sign in with the token it prints.
//
// Its parts are in dashboard-demo/: the hill climb, the goal campaign, the research campaign and
// its reviews, what the rigs report and the live sessions. The rigs are made in the order below,
// which the seeded random sequences depend on.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createControlApi } from "../src/control/api.ts";
import { issueCommand } from "../src/control/issue.ts";
import { ControlStore } from "../src/control/store.ts";
import { generateSigningKeys } from "../src/core/commands.ts";
import { goalRig } from "./dashboard-demo/goal.ts";
import { hillClimbRigs } from "./dashboard-demo/hill-climb.ts";
import { liveSessions } from "./dashboard-demo/live.ts";
import { reportRigs } from "./dashboard-demo/reports.ts";
import { pilotRig, researchRig } from "./dashboard-demo/research.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8810" } } });

const store = new ControlStore(join(mkdtempSync(join(tmpdir(), "thermite-demo-")), "control.db"));
const rigs = ["gpu-1", "gpu-2", "gpu-3", "cpu-1", "gpu-4"];
store.setConfiguredRigs(rigs);

const { g1, g2 } = hillClimbRigs();
const g3 = goalRig();
const c1 = researchRig();
const g4 = pilotRig();
reportRigs(store, { g1, g2, g3, c1, g4 });
liveSessions(store);

const keys = generateSigningKeys();
const tokens = {
  admin: "demo-admin-token-0123456789",
  rigs: Object.fromEntries(rigs.map((u) => [u, `rig-${u}-token-abcdef`])),
};
for (const [rig, kind, payload] of [
  ["gpu-1", "pause_run", { run: "decode-a", reason: "owner check" }],
  ["gpu-1", "resume_run", { run: "decode-a" }],
  ["gpu-2", "export_now", {}],
  [
    "gpu-3",
    "redirect",
    {
      run: "regex-dfa-1",
      directives: [
        {
          kind: "try",
          family: "simd-prefilter",
          rationale: "the prefilter probe skips most of the input",
          citations: [],
        },
      ],
      replace: true,
    },
  ],
] as const) {
  issueCommand(store, keys.privateKeyPem, { rig, kind, payload, issuedBy: "owner:ui" });
}
store.addReport(
  "gpu-1",
  "daily",
  "Daily report for gpu-1\n\nCampaign decode-speed (decode-a): champion seq 6, +24.1% over its baseline.\n48 attempts today: 6 wins confirmed, 1 held by audit.\nAgents: 16 epochs, 48 trials, planner valid 94%.",
);

// A model provider whose list prices one model and not the other (goal 075's price field).
store.putProvider({
  name: "demo-models",
  type: "openai",
  base_url: "https://models.example.com/v1",
  key: { sealed: "demo", hint: "…demo" },
});
store.setProviderModels("demo-models", [
  {
    id: "glm-5.1",
    context_window: 131_072,
    price: { input: 0.6, cached_input: 0.11, output: 2.2 },
  },
  { id: "kimi-k3", context_window: 262_144 },
]);

const port = Number(values.port);
serve({
  fetch: createControlApi(store, tokens, keys.privateKeyPem, { staleAfterMs: 180_000 }).fetch,
  hostname: "127.0.0.1",
  port,
});
console.log(`dashboard demo: http://127.0.0.1:${port}/ui  (token: ${tokens.admin})`);
