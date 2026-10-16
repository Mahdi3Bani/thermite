# Running Thermite locally

Thermite runs the same images under docker-compose, podman-compose and Kubernetes. Locally, one compose stack starts the control service and one rig (a harness and a supervisor), with the CPU target.

**Status:** the stack runs everything on the CPU target:
- the judge;
- control's dashboard (`http://127.0.0.1:8800/ui`), API and MCP;
- agents, when a model route is configured;
- the supervisor's advisors, when a config file is given.

Without a model route, a "proposer" is you, submitting patches.

## Requirements

- Node.js 22.15 or later, for the checks and the command line.
- Docker with Compose, or Podman with `podman compose` or podman-compose.

## Checks

```sh
npm ci
npm run check            # typecheck, lint, tests, public-content check
```

## The compose stack

```sh
npm run dev:init         # writes local tokens to .dev/ (git-ignored)
npm run build
docker compose up -d --build     # or: podman compose up -d --build
```

- **control** listens on `127.0.0.1:8800`. It generates its command-signing key on first start and shares only the public key with the harness.
- **harness** has no published port. Only its supervisor reaches it, over the rig's internal network. It reads imports from `.dev/inbox` (read-only) and writes exports to `.dev/outbox`.
- **supervisor** polls the harness, sends new events to control and relays control's commands. The interval is `THERMITE_POLL_SECONDS` (60 by default).

## The dashboard

Sign in at `http://127.0.0.1:8800/ui` with the admin token from `.dev/secrets/control-admin-token`. A sign-in survives restarts of control and renews while you use it. A session left unused for 30 days ends (`THERMITE_CONTROL_SESSION_DAYS`), and so does every session when the admin token changes. The pages follow the work's hierarchy, Campaign ▸ Run ▸ Lane ▸ Trial ▸ Attempt:

- **Overview** lists what waits for you first, then campaigns and rigs.
- **Campaigns** shows each campaign with its runs on every rig. A campaign's page sums up its runs at the top, then shows one run at a time in tabs, with its overview, attempts and steering.
- **Rigs** shows each rig's hardware, judge, results export, advisors and key. A rig's harness reports its hardware when it starts: each device and who uses it, the driver, CPU and memory limits, disks and compilers.
- **Live** shows a rig's agent sessions and its judge as they work. The supervisor relays new lines every `THERMITE_LIVE_INTERVAL_MS` milliseconds (3000 by default). From a session you can message a worker's trial, a lane, the planner or the advisors. The message is a signed `message_agent` command, which only the owner's credential can issue. A worker reads it after its current turn.

To work on the dashboard without a stack, run a demo with synthetic campaigns and rigs:

```sh
node --experimental-strip-types scripts/dashboard-demo.ts   # http://127.0.0.1:8810/ui
```

It prints the token to sign in with.

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

Set `KEEP=1` to leave the stack running afterwards.

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

Confirmed wins promote automatically by default (`THERMITE_PROMOTION=auto`). Gains above the contract's audit trigger are still held for an audit, and a gain above the absolute trigger still waits for the owner. Set `THERMITE_PROMOTION=owner_approval` to approve every promotion yourself.

## Agents

Workers and the planner run when the harness has a model route: an OpenAI-compatible endpoint given by `QWEN_BASE_URL` and `QWEN_MODEL`, with its key in `.dev/secrets/qwen-api-key` (git-ignored; `dev:init` writes a placeholder). Without a route, the judge still runs and you submit patches yourself.

- Set `QWEN_CONTEXT_WINDOW` to the model's context per request. Each reply's length is then clamped to the room left, and a worker is told to submit at 80% of it. Unset means unknown: no clamping, and a request that is too long ends the trial when the server refuses it.
- `QWEN_MAX_TOKENS` (default 8192) caps each reply, thinking included.

`node scripts/agents-acceptance.mjs` checks the agent machinery without a real model: a scripted model on your machine plans one epoch and plays two workers, which edit, build, use the device and submit through the real harness image.

## Supervision: advisors, results and lifecycle

**Advisors.** The supervisor runs the teacher pair, the combiner, the auditor and the review panel when `THERMITE_ADVISORS_FILE` names a JSON config. Locally, put it in `.dev/advisors/`, which is mounted at `/etc/thermite/advisors`:

```json
{
  "teachers": [
    { "name": "teacher-a", "runtime": "openai", "base_url": "https://gateway.example/v1",
      "model": "a-frontier-model", "api_key_file": "/etc/thermite/advisors/key-a" },
    { "name": "teacher-b", "runtime": "cli", "restricted": true,
      "argv": ["an-agent-cli", "--print", "--json", "--no-shell", "--no-file-tools"] }
  ],
  "combiner": { "name": "combiner", "runtime": "openai", "base_url": "https://gateway.example/v1",
    "model": "a-frontier-model", "api_key_file": "/etc/thermite/advisors/key-a" },
  "auditor": { "name": "auditor", "runtime": "cli", "restricted": true,
    "argv": ["an-agent-cli", "--print", "--json", "--no-shell", "--no-file-tools"] },
  "panel": [],
  "teacher_minutes": 60,
  "fetch_domains": ["arxiv.org", "github.com"],
  "max_usd_per_day": 20
}
```

- An `openai` runtime runs inside the supervisor, with read-only tools: the campaign brief, a guarded web fetch, and an optional knowledge-base search.
- A `cli` runtime runs a command-line agent: it gets the prompt on stdin and prints one JSON answer.
  - It runs as the supervisor's user, so its argv must turn off the agent's own shell and file tools.
  - `"restricted": true` states that it does. Thermite can't check another program's flags.
  - It gets an empty home and working directory, and its whole process group is killed at its time limit.
- Neither runtime gets a shell or file tools from Thermite.
- Web fetch is off unless `fetch_domains` lists domains. With `"*"` (any public site), the knowledge-base search is left out of the same agent, and the auditor fetches only from listed domains.
- `max_usd_per_day` caps what all advisors of a rig spend.
- What they produce is checked twice, by the supervisor and by the harness:
  - directives need citations;
  - an audit can block a promotion, never force one;
  - a panel's pass still needs the owner's acceptance.

**Results repository.** Locally, both rigs' supervisors push their exports to one repository on a shared volume (`file:///results/results.git`). Set `THERMITE_RESULTS_REMOTE` (and `THERMITE_RESULTS_KEY_FILE` for SSH) to use a real one. Propagation reads published champions from it.
- Set `THERMITE_RESULTS_KNOWN_HOSTS` to a known_hosts file to pin the git host's key. Without it, the first key the host shows is trusted.
- The supervisor commits only regular files that the export's manifest lists, and never replaces a file already published. After a push, the harness removes the pushed exports from the outbox.

**Rig keys.** Control pins each rig's report-signing key the first time the rig reports. With `THERMITE_CONTROL_REQUIRE_KEY_ACCEPT=1`, it holds every first key instead. You accept the key on the rig's page, or with `POST /v1/rigs/<rig>/key/accept?fingerprint=<fingerprint>`, after checking the fingerprint against the rig's deployment. A changed key is always held the same way. A full reset keeps the rig's key.

**Pending commands.** A command still waiting for its rig can be cancelled with `POST /v1/commands/<id>/cancel` (admin token). Commands past their expiry are marked expired and never delivered.

**Lifecycle.** To let control restart containers, add `compose.lifecycle.yaml`, which mounts the container engine's socket into control. This is for development only; on Kubernetes, control deletes a rig's pods through its service account instead.

```sh
THERMITE_ENGINE_SOCKET_HOST=/path/to/engine.sock \
  podman compose -f compose.yaml -f compose.lifecycle.yaml up -d
```

A **full reset** (owner only, from the dashboard or `POST /v1/rigs/<rig>/reset`) goes through these steps:
1. pause the rig's campaigns;
2. wait until its judge is idle;
3. take a full export (the ledger snapshot and the research archive);
4. wait until the supervisor reports that export pushed to the results repository;
5. **you confirm**, after checking the reported commit in the results repository;
6. the signed wipe, then a restart.

- The harness refuses the wipe if anything but housekeeping was recorded after the export.
- After the wipe it refuses commands issued before it.

## A long research run

`node scripts/research-longrun.mjs` runs a research campaign for a set time (`MINUTES`, 125 by default) with a scripted worker.
- It reads real public pages, at about one page every two minutes, with robots.txt respected.
- It records quote-verified claims, and kills the harness controller once halfway.
- It checks that the campaign closes on its clock with digests, verified claims and a final report.
- This tests the machinery only; research quality needs a real model.

To run it beside another stack, give it its own project and control port: `THERMITE_PROJECT=thermite-longrun THERMITE_CONTROL_PORT=8801`.

## The steering acceptance test

`node scripts/steering-acceptance.mjs` runs two rigs with a scripted model on your machine. It checks:
- directives from the teacher pair and their attribution in the next epoch;
- an audit block holding a confirmed win, and a cleared audit letting the next one promote;
- propagation of a champion to the second rig, judged there and shown cross-verified;
- the supervisor's limits (it cannot submit, and it cannot forge a command);
- daily reports;
- a restart, when an engine socket is available;
- a full reset.

## The command line

`thermite` validates contracts, prints campaign assignments, issues commands through control and submits patches:

```sh
node dist/cli/thermite.js contract validate examples/contracts/smoke-cpu.json
node dist/cli/thermite.js help
```

Inside the harness container the same tool is on the path as `thermite`.
