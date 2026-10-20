# Running Thermite locally

This page is for people working on Thermite itself: the checks, the compose stack you develop against, the dashboard demo and the acceptance tests. To **use** Thermite, start with the documentation site: [Your first run](_site/src/content/docs/tutorials/first-run.md), then the [how-to guides](_site/src/content/docs/how-to/install/one-machine.md).

Thermite runs the same images under docker-compose, podman-compose and Kubernetes. Locally, one compose stack starts the control service and one rig (a harness and a supervisor), with the CPU target.

## Requirements

- Node.js 22.19 or later, for the checks and the command line (the agent libraries require it).
- Docker with Compose, or Podman with `podman compose` or podman-compose.

## Checks

```sh
npm ci
npm run check            # typecheck, lint, tests, public-content check
```

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main` and to the development branch, `v1/build`. It runs the same checks on Node 22 and 24, builds and checks the documentation site, then runs the compose smoke test with Docker. [What CI runs](_site/src/content/docs/project/contributing.md#what-ci-runs) describes each job, and [AGENTS.md](../AGENTS.md#checks) lists every check and when each one is needed.

The documentation site has its own build and checks: see [Writing the documentation](writing-docs.md).

## The compose stack

```sh
npm run dev:init         # writes local tokens to .dev/ (git-ignored)
npm run build            # the command line on your computer: npx thermite
docker compose up -d --build     # or: podman compose up -d --build
```

The stack, its settings and how to operate it are described on the site:

- what each container is, its volumes and how to keep it running: [Install Thermite on one machine](_site/src/content/docs/how-to/install/one-machine.md);
- every setting: [Settings](_site/src/content/docs/reference/settings.md);
- models, advisors, the results repository, keys, tokens, restarts and resets: the [how-to guides](_site/src/content/docs/how-to/operate/check-a-rig.md);
- MCP and the REST API: [Let an agent run Thermite over MCP](_site/src/content/docs/how-to/automate/agent-over-mcp.md) and [Script Thermite with the REST API](_site/src/content/docs/how-to/automate/rest-api.md);
- the command line: [Command line](_site/src/content/docs/reference/command-line.md).

The `two-rigs` profile adds a second rig (`local-2`), which the control and steering acceptance tests use. `compose.lifecycle.yaml` lets control restart containers through the engine's socket; it is for development only.

`compose.yaml` passes the optional settings through from your shell or `.env`, each with its default. That includes the knowledge base's two timers: `THERMITE_KB_SYNC_SECONDS` for both rigs' supervisors (180), and `THERMITE_OUTSIDE_KB_SYNC_SECONDS` for control (300). Set one lower to see past research or an outside copy move sooner, or to `0` to turn that timer off; **Sync now** still copies a folder by hand.

## The dashboard demo

To work on the dashboard without a stack, run a demo with synthetic campaigns and rigs:

```sh
node --experimental-strip-types scripts/dashboard-demo.ts   # http://127.0.0.1:8810/ui
```

It prints the token to sign in with. One of its runs has a made-up experiment queue: experiments tried, in progress and up next, a lane's idea and a hand-out. The same run has five made-up field notes on its **Journal** tab, from lane-1, lane-2, the planner, the auditor and a teacher, and the **Knowledge** page shows a folder for each of the demo's campaigns, built from their events. The demo has no campaign saved on control or assigned through it and no owner's messages, so it shows no **Start a run** and no kept messages; the dashboard's tests cover those. One of them (`src/control/dashboard.test.ts`) also drives the **Experiments** and **Planner** tabs through a real harness: it adds, moves and drops experiments, and adds and removes a rule in free words. The dashboard's tests use a smaller fixture with the shapes the harness writes (`src/testing/control-demo.ts`): a goal campaign with attempts held for audits, a run at work, and a hill climb with an approval and an auditor's block, field notes and a research note.

The documentation's screenshots come from the demo, whose data is made up. With the demo running, `node scripts/docs-screenshots.mjs` takes them again: the Overview, the Campaigns list, a run's page, the run's **Experiments** and **Journal** tabs, Live for a run at work, the **Knowledge** page and a rig's page, at 1440×900 in the light theme, as WebP files in `docs/_site/src/assets/screenshots/`. It needs a local Chrome or Chromium (`--chrome PATH`); `--out DIR` writes the files elsewhere, to look at them first.

## Journals and the knowledge base

Goal 065's parts are covered by unit tests, which `npm test` runs like any other: field notes (`src/harness/journal.test.ts`, `src/harness/agents/scheduler-notes.test.ts`), research in every mode (`src/harness/research/research-everywhere.test.ts`), the export (`src/harness/export-notes.test.ts`), the supervisor's past-research sync (`src/supervisor/kb-sync.test.ts`), the advisors' notes (`src/supervisor/advise-notes.test.ts`), control's knowledge base and its pages (`src/control/kb.test.ts`, `src/control/kb-ui.test.ts`) and outside knowledge bases (`src/control/outside-kb.test.ts`, `src/supervisor/advise-outside-kb.test.ts`).

- **A fake outside knowledge base** (`src/testing/fake-kb.ts`) stands in for a GBrain-style brain: an MCP server on a free local port that takes one bearer token, with a search tool and a page-writing tool shaped like GBrain's `put_page`. It keeps every page, call and request, so a test can look at what control and the supervisor sent. A test can make it refuse every page (`failWrites`), or only the pages whose slug holds some words (`failPage`), as a server does that refuses one page for good.
- **Control's assignments** (`src/testing/assignments.ts`): control serves a rig's past research and outside knowledge bases only for runs it assigned, so a test that seeds a rig's events records control's own assignment of the run with `assigned(store, rig, run, campaign)`.

No compose acceptance test covers them yet.

## The smoke test

The smoke test runs the whole path once, end to end:

1. It bundles the smoke project and its kit into the inbox.
2. It starts the stack.
3. It assigns a campaign through control with a signed command. The supervisor relays the command, and the harness imports both bundles and checks their commits and hashes.
4. It submits one candidate as a proposer from inside the harness container.
5. It waits until the judge's verdict reaches control, then stops the stack and removes its volumes.

```sh
COMPOSE="docker compose" npm run smoke:compose
COMPOSE="podman compose" npm run smoke:compose
COMPOSE="podman-compose" npm run smoke:compose
```

Set `KEEP=1` to leave the stack running afterwards. To run it beside another stack, give it its own project and control port: `THERMITE_PROJECT=thermite-smoke THERMITE_CONTROL_PORT=8801`.

### The smoke project's commits

A rig's smoke check (one of its [rig checks](_site/src/content/docs/how-to/operate/check-a-rig.md)) makes git repositories from `examples/smoke-project` and `kits/smoke-cpu` (without its candidates). The same files always give the same commits, and `examples/contracts/smoke-cpu-goal.json`, the contract of the [goal-campaign tutorial](_site/src/content/docs/tutorials/first-goal-campaign.md), names them. So a change to either folder changes the commits the contract must name. A unit test in `src/harness/smoke-check.test.ts` makes the repositories as the smoke check does and compares: when it fails, it says which field of the contract to set to which commit.

## The judge acceptance test

`npm run acceptance:judge` runs the smoke campaign (`kits/smoke-cpu`, `examples/smoke-project`) through the whole judge under compose. It submits every candidate in `kits/smoke-cpu/candidates`, each with an expected outcome:

| Candidate | Expected |
| --- | --- |
| A faster kernel | screened, confirmed on fresh data, promoted |
| The same kernel, restated | neutral |
| Wrong results, a build error, NaN output | invalid |
| A timer in the kernel, an edit to the reference | refused before building (static checks) |
| A call to the reference implementation | invalid: the dispatch probe shows the reference ran |
| Too much memory, a full disk | crash_candidate: killed at the run's limits |
| An attempt to overwrite the champion's binary | judged normally; the build store is unchanged |
| A process left running after the benchmark | judged normally; nothing of the run survives it |

It also checks that every role user is refused access to the ledger, kits, builds, secrets and the broker; that a killed controller is recorded as one infrastructure failure and the job still completes; and that the A/A noise of the machine is measured. The report goes to `.dev/acceptance/`.

```sh
COMPOSE="podman compose" npm run acceptance:judge
```

## Agents without a model

`node scripts/agents-acceptance.mjs` checks the agent machinery without a real model: a scripted model on your machine plans one round and plays two workers, which edit, build, use the device and submit through the real harness image.

## A long research run

`node scripts/research-longrun.mjs` runs a research campaign for a set time (`MINUTES`, 125 by default) with a scripted worker.

- It reads real public pages, at about one page every two minutes, with robots.txt respected.
- It records quote-verified claims, and kills the harness controller once halfway.
- It checks that the campaign closes on its clock with digests, verified claims and a final report.
- This tests the machinery only; research quality needs a real model.

## The steering acceptance test

`node scripts/steering-acceptance.mjs` runs two rigs with a scripted model on your machine. It checks:

- directives from the teacher pair and their attribution in the next round;
- an audit block holding a confirmed win, and a cleared audit letting the next one promote;
- propagation of a champion to the second rig, judged there and shown cross-verified;
- the supervisor's limits (it cannot submit, and it cannot forge a command);
- daily reports;
- a restart, when an engine socket is available;
- a full reset.

## Other acceptance tests

[AGENTS.md](../AGENTS.md#checks) lists the rest, each with when it is needed: control (two rigs), new campaign, machines over SSH, clusters on kind, rig deploy, multi-GPU and Claude Code. Each uses local stand-ins, never a real host or cluster. Two of them check more than their names say:

- **New campaign** (`scripts/campaign-acceptance.mjs`) creates a campaign through the New campaign form, which starts a try of its kit, then starts the campaign's own run from the campaign's page (**Start a run**) with the agents on. The rig gets a model route that nothing answers (`THERMITE_MODEL_BASE_URL=http://127.0.0.1:9/v1`), so control lets the agents start and they fail at once; the script submits the changes itself.
- **Clusters on kind** (`scripts/cluster-acceptance.mjs`) keeps control's records on a Podman volume. After the slot's rig reports, it tags both rig images `:accept-update`, loads them into kind and restarts control with them. Then it checks that the rig's page offers **Update to these images**, that the rig's new pods run those images and report again, and that its volume claim and secret are unchanged. The update is tried on the slot's CPU rig only.

## Clean up

The compose scripts prune dangling images and trim the Podman VM when their stack comes down. After a run stopped by hand, do the same: `podman image prune -f`, then `podman machine ssh sudo fstrim -a`. Never prune tagged images, which may be other projects'.
