# Running Thermite locally

Thermite runs the same images under docker-compose, podman-compose and Kubernetes. Locally, one compose stack starts the control service and one rig (a harness and a supervisor), with the CPU target.

**Status:** the stack runs everything on the CPU target:
- the judge;
- control's dashboard (`http://127.0.0.1:8800/ui`), API and MCP;
- agents, when a model route is configured;
- the supervisor's advisors, when a config file is given.

Without a model route, a "proposer" is you, submitting patches.

## Requirements

- Node.js 22.19 or later, for the checks and the command line (the agent libraries require it).
- Docker with Compose, or Podman with `podman compose` or podman-compose.

## Checks

```sh
npm ci
npm run check            # typecheck, lint, tests, public-content check
```

CI (`.github/workflows/ci.yml`) runs the same checks on Node 22 and 24 for every pull request and push to `main`, then the compose smoke test with Docker.

## The compose stack

```sh
npm run dev:init         # writes local tokens to .dev/ (git-ignored)
npm run build
docker compose up -d --build     # or: podman compose up -d --build
```

- **control** listens on `127.0.0.1:8800`. It generates its command-signing key on first start and shares only the public key with the harness.
- **harness** has no published port. Only its supervisor reaches it, over the rig's internal network. It reads imports from `.dev/inbox` (read-only) and writes exports to the `outbox` volume, which its supervisor reads and pushes to the results repository.
- **supervisor** polls the harness and sends new events to control every `THERMITE_POLL_SECONDS` (60 by default). It fetches control's commands on a shorter interval, `THERMITE_COMMAND_POLL_SECONDS` (5 by default), so a pause or a message lands within seconds.

## The dashboard

Sign in at `http://127.0.0.1:8800/ui` with the admin token from `.dev/secrets/control-admin-token`. A sign-in survives restarts of control and renews while you use it. A session left unused for 30 days ends (`THERMITE_CONTROL_SESSION_DAYS`), and so does every session when the admin token changes. The pages follow the work's hierarchy, Campaign ▸ Run ▸ Lane ▸ Trial ▸ Attempt:

- **Overview** lists what waits for you first. Each decision says what it is about, what the judge found, why it waits and what each button does. Beside the decisions: what each running run's judge, planner and lanes are doing now, and what happened lately, in words.
- **Campaigns** shows the runs at work now, what waits for you, and every campaign as one row, with filters and a search box. A campaign's page shows its runs at work, its earlier runs in one table and **Start a run**. A run has its own page with tabs for its overview, attempts, history and planner. Each attempt has its own page.
- **Rigs** shows each rig's hardware, judge, results export, advisors and key. A rig's harness reports its hardware when it starts: each device and who uses it, the driver, CPU and memory limits, disks and compilers.
- **Live** shows one run at a time as its agents and judge work, with a filter for each lane, the planner, the judge, the advisors and your own messages. The supervisor relays new lines every `THERMITE_LIVE_INTERVAL_MS` milliseconds (3000 by default). The message box under the stream writes to the lane you watch, or to everyone working, the planner or the advisors. The message is a signed `message_agent` command, which only the owner's credential can issue. A rig's page still opens every session on that rig. When each agent reads it (a Pi worker at its next step; OpenCode and Claude Code workers when their current run ends) is in [Architecture](architecture.md#the-owners-messages).

To work on the dashboard without a stack, run a demo with synthetic campaigns and rigs:

```sh
node --experimental-strip-types scripts/dashboard-demo.ts   # http://127.0.0.1:8810/ui
```

It prints the token to sign in with. The dashboard's tests use a smaller fixture with the shapes the harness writes (`src/testing/control-demo.ts`): a goal campaign with attempts held for audits, a run at work, and a hill climb with an approval and an auditor's block.

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

Workers and the planner run when the harness has a model route: an OpenAI-compatible endpoint given by `THERMITE_MODEL_BASE_URL` and `THERMITE_MODEL` (the model's name), with its key in `.dev/secrets/model-api-key` (git-ignored; `dev:init` writes a placeholder). Without a route, the judge still runs and you submit patches yourself. The settings' older names, `QWEN_*`, are still read when the new ones are not set.

- The model must support OpenAI-style tool calling: the planner answers through a tool, and workers work only through tools.
- `THERMITE_MODEL_BASE_URL` ends in `/v1`, for example `https://gateway.example/v1`.
- A server on your own machine is `http://host.docker.internal:PORT/v1` from inside the containers (with Podman, `host.containers.internal` works too). `localhost` is the container itself.
- Set the variables in your shell or in a `.env` file next to `compose.yaml` before `compose up`, for example:

  ```sh
  THERMITE_MODEL_BASE_URL=http://host.docker.internal:8000/v1 THERMITE_MODEL=my-model \
    docker compose up -d --build
  ```

- Set `THERMITE_MODEL_CONTEXT_WINDOW` to the model's context per request. Each reply's length is then clamped to the room left, and a worker is told to submit at 80% of it. Unset means unknown: no clamping, and a request that is too long ends the trial when the server refuses it.
- `THERMITE_MODEL_MAX_TOKENS` (default 8192) caps each reply, thinking included. `THERMITE_MODEL_REASONING_EFFORT` (none, low, medium or high) is sent as the request's `reasoning_effort` when set.

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
- A role given a model on control's Edit rig page uses that model instead of this file. A Claude subscription's model runs in Claude Code with no tools (the supervisor image needs `CLAUDE_CODE_VERSION`); an API key's model runs as an `openai` runtime.
- No runtime gets a shell or file tools from Thermite.
- Web fetch is off unless `fetch_domains` lists domains. With `"*"` (any public site), the knowledge-base search is left out of the same agent, and the auditor fetches only from listed domains.
- `max_usd_per_day`, when you set it, caps what all advisors of a rig spend in a day. Without it there is no limit. It counts only what it can price: set `usd_per_mtok_in` and `usd_per_mtok_out` on each `openai` runtime, or the cap never trips. A `cli` runtime's spend is not counted, nor is a model given on Edit rig.
- What they produce is checked twice, by the supervisor and by the harness:
  - directives need citations;
  - an audit can block a promotion, never force one;
  - a panel's pass still needs the owner's acceptance.

**Getting a result.** A run's champion is published with the rig's next export (every `THERMITE_EXPORT_MINUTES`, 60 by default, or at once with Export now on the rig's page). Its supervisor then uploads the patch to control, which keeps it only if it matches the sha256 the rig published. The run's "at work" panel links it ("download champion #N as a patch"), and the API serves it at `GET /v1/rigs/<rig>/champions/<run>/<seq>/patch` with the owner's token. Apply it to the run's starting commit, which the link names: `git apply` in a checkout of that commit.

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

## Rig checks

A rig checks itself when control asks: from its page in the dashboard (Checks), with the `rig_check` command over MCP, or with `thermite command --control <URL> --token-file <file> --rig <rig> --kind rig_check --payload '{"check":"smoke"}'`. Each check reports pass or fail in a sentence, in the rig's history and on its page.

| Check | What it does | When |
| --- | --- | --- |
| `model` | One short request through the rig's model route, as its workers and planner make them. It must come back as a correct tool call. | After the model server or its settings change, before resuming runs |
| `isolation` | The isolation selftest: each role's user tries to reach what it must not. | The harness runs it at every start, before its API, judge and agents. Run it again after changing a rig; it needs an idle rig |
| `smoke` | A judge-only campaign from the smoke kit in the harness image, on the rig's own target. Candidates with known verdicts (a real win, a no-op, broken changes, ways to cheat) must each get theirs. | After deploying a rig or a new version. Needs an idle rig; its running runs are paused for it and resumed after |

An idle rig has no open trials and no judge jobs. A busy rig answers "not now". `"force": true` runs the check anyway, ending what its probes touch.

## Credentials and agents over MCP

Control has four kinds of token:

| Token | May |
| --- | --- |
| Owner (admin) | Everything, including approvals, accepting reviews and endings, and wipes |
| Operator | Read; assign, pause, resume, redirect, reset workers and export; message the run's agents on the owner's behalf |
| Agent | Read; assign, pause, resume, redirect, reset workers and export |
| Reader | Read |

Locally, `dev:init` writes the owner's and an operator's tokens to `.dev/secrets/`, and compose gives control the files.

Deployed, give control only each token's hash, as `THERMITE_CONTROL_<ROLE>_TOKEN_SHA256` for `ADMIN`, `OPERATOR`, `AGENT` or `READ`. Make each token on your own machine:

```sh
node dist/cli/thermite.js token new --out ~/thermite-owner-token   # prints its SHA-256
```

Keep the token, for example in a password manager. The machine control runs on then holds nothing that signs in.

MCP is at `/mcp` on control (streamable HTTP), with the token as a bearer. For example, to let Claude Code operate the local stack:

```sh
claude mcp add --transport http thermite http://127.0.0.1:8800/mcp \
  --header "Authorization: Bearer $(cat .dev/secrets/control-operator-token)"
```

Every token can read a run's experiment queue with `run_queue`: up next in order, the lanes' ideas, what each lane is on, what was tried and with what result, the rules for the plan, the planner's hand-outs and the owner's messages with who read them. Tokens that steer change it with `issue_command` (`queue_add`, `queue_move`, `queue_drop`, `queue_accept`, `redirect`, `drop_directive`).

Every token except an agent's also reads control itself, to find out why something didn't work:

- `control_log`: control's audit log, newest first. It includes what the dashboard refused, with why (action `refused`), and requests that failed (action `failed`). Control also writes these to its output, one JSON line each.
- `providers`: what control holds in Settings › Providers and what it last read from each, with the last error. It never shows a key, a token or a kubeconfig.
- `runpod_tests`: test pods on a RunPod account, with their findings and cost. An operator's or the owner's token also has `runpod_test_start`, which spends money, and `runpod_test_end`.

The owner's and operators' tokens also set rigs up and give them models, through the same checks as the pages: `add_cluster_rig` (as Rigs › Add a rig, on a Kubernetes cluster; its CPUs, memory and volume default to the slot's quota), `set_cluster_slots` (a cluster's pre-made slots), `update_rig_images` (a rig control set up on a cluster moves onto control's images, as on its page; `rig_setup` then shows each step, and the rig's status there) and `set_rig_model` (a rig's agents' model, as on Edit rig). Retiring a rig (`retire_rig`, `bring_back_rig`) is the owner's.

## The command line

`thermite` validates contracts, starts runs, issues commands through control and submits patches. After `npm run build`, run it as `npx thermite` (or `node dist/cli/thermite.js`):

```sh
npx thermite contract validate examples/contracts/smoke-cpu.json
npx thermite help
```

Inside the harness container the same tool is on the path as `thermite`.

### Adding a rig

Control makes a new rig's token when the owner enrolls it, so control needs no restart and no change to its deployment:

```sh
npx thermite rig add gpu-rig-1 --control https://control.example.com \
  --token-file ~/.config/thermite/owner-token --out rig-gpu-rig-1
```

The output directory gets the rig's control token, a token its harness and supervisor share, control's public key and its fingerprint, and the rig's name and control's address, with a README that maps each file to its setting. Tokens are written to files (mode 0600) and never printed; control keeps only their SHA-256.

`thermite rig token <rig> … --out FILE` replaces an enrolled rig's token; the old one stops working at once. Rigs listed in `THERMITE_CONTROL_RIG_TOKENS_FILE` keep their tokens there.

A rig that is gone can be retired, whatever set it up: from its page (Retire it, typed to confirm), `thermite rig retire <rig> …`, `POST /v1/rigs/<rig>/retire`, or the owner's MCP tool `retire_rig`. It leaves the rig lists, its campaigns' pages and Needs you, and control refuses its reports, even with a token from the file (take that out of the file too). A token control made for it ends. Its records stay, and it can be brought back from its page, `POST /v1/rigs/<rig>/bring-back` or `bring_back_rig`; enrolling it again also brings it back. Retiring stops nothing on the machine.
