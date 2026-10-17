# Quick start: Thermite on one machine

This page takes you from a clean clone to a running rig on your own machine. The rig checks
itself with a smoke campaign, then you point it at a model and at your own project. It takes about
20 minutes, most of it building images.

You need:

- Linux or macOS, with a few CPU cores and a few GB of memory (the stack itself uses well under 1 GB; your project's builds use more);
- Node.js 22.19 or later;
- Podman (with `podman compose`) or Docker (with `docker compose`);
- git.

A model endpoint is optional at first. Without one, the judge works, and you can submit
changes yourself.

## 1. Build and start the stack

```sh
git clone https://github.com/<owner>/thermite.git
cd thermite
npm ci
npm run build
npm run dev:init                 # writes local tokens to .dev/ (git-ignored)
docker compose up -d --build     # or: podman compose up -d --build
```

The stack is three containers:

- **control**: the dashboard, API and MCP, at `http://127.0.0.1:8800`.
- **harness**: the rig's judge, agents and ledger. It has no published port.
- **supervisor**: it relays between the harness and control.

The rig is called `local-1`.

## 2. Sign in

Open `http://127.0.0.1:8800/ui` and sign in with the token in
`.dev/secrets/control-admin-token`. The overview shows what needs you and what is at work. Both
are empty for now.

## 3. Let the rig check itself

Go to **Rigs › local-1**. Under **Checks**, run:

1. **isolation.** Each part of the rig tries to reach what it must not, such as the judge's files,
   secrets and other parts' work. It passes in a minute or two.
2. **smoke.** The rig builds a small benchmark project and its kit from its image, starts a
   judge-only campaign, and submits changes with known outcomes: a real speed-up, a no-op, broken
   changes, and ways to cheat the timer or the reference. Each must get its expected verdict. On a
   CPU rig this takes about ten minutes.

Each result shows on the rig's page and in its history, in a sentence. While the smoke runs, a
run named `check-smoke-…` appears under **Campaigns**, and you can watch the judge work. It
closes when the check is done.

## 4. Connect a model

Workers and the planner need a model with tool calling, from an OpenAI-compatible provider or
Anthropic. You add it on the dashboard, with no restart:

1. Open **Settings** and add a provider: a name, its type, its base URL (for an OpenAI-compatible
   provider, the URL ending in `/v1`; for Anthropic, leave it empty) and its API key. Control
   lists the provider's models from the provider itself.
2. Under **Harness and model for each rig**, choose the harness the rig's agents run in and their
   model, then press **Use**. The rig takes it within a minute and checks it at once: one request
   through it must come back as a correct tool call. If it fails, its sentence says what came back
   instead: no tool call, a refusal, or a cut-off reply. **Check** runs it again.

The harness is **Pi** (built in) or **OpenCode v2**. Under OpenCode, each trial runs `opencode` in
the lane's workspace as the lane's own user, with its own tools approved, and submits with the
`thermite-trial` command; a provider's key stays in the harness, which adds it to OpenCode's
requests. Any provider works with either harness. OpenCode's own models (add a provider of type
OpenCode, with no key for its free models) run only under OpenCode.

Control keeps the key encrypted and never shows it again: the page shows only its last four
characters. Only the rigs you give one of the provider's models receive the key, and the agents
use it from their next plan or trial. If a provider does not list a model you need, add it by its
name under the provider.

For a server on your own machine, the base URL is `http://host.docker.internal:<port>/v1`. With
Podman, `host.containers.internal` works too.

A rig can also take its model from its own settings (`THERMITE_MODEL_*`, see
[Settings reference](settings-reference.md)). A model chosen on the settings page comes first.

## 5. Run a campaign on your own project

A campaign needs three things:

1. **A kit.** It builds your project, runs its benchmark and checks the result. See
   [Write a kit](write-a-kit.md). Start from `kits/smoke-cpu`.
2. **A contract.** It names the project, the kit, the objective and the limits. Start from an
   example in `examples/contracts/` (a hill climb, a goal campaign and a research campaign), see
   [Contract reference](contract-reference.md), and check it with `npx thermite contract validate`.
3. **Both repositories where the rig can fetch them.** Use a git host the supervisor can reach,
   such as a public or deploy-keyed repository. Without one, put the bundles in `.dev/inbox/` by
   hand (see [Write a kit](write-a-kit.md)).

Start the run:

```sh
npx thermite assign --contract contract.json --run my-run-1 \
  --seed https://git.example/my-project.git@<commit> --kit https://git.example/my-kit.git \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
```

The supervisor fetches both commits. The harness checks the kit against the contract, then the
run starts. Its workers propose changes, and the judge measures them. A confirmed win becomes the
run's champion, unless the run waits for your approval (`--promotion owner`).

## 6. Take the result

When the rig exports, the run's panel offers the champion: **download champion #N as a patch**.
The rig exports every hour, or at once with **Export now** on its page. Apply the patch to the
starting commit the link names:

```sh
git -C my-project checkout <starting commit>
git -C my-project apply ~/Downloads/my-run-1-champion-N-on-<commit>.patch
```

## Next

- [Running locally](local-development.md): every setting, the checks, credentials and agents
  over MCP.
- [Campaign modes](campaign-modes.md): hill climbing, goals and research.
- [Judging and integrity](judging.md): what the judge accepts, and why.
