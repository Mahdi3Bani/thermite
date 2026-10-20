---
title: "Install Thermite on one machine"
description: "Run control and a rig on one computer with Docker or Podman, and keep them running."
type: how-to
sidebar:
  order: 1
---

This guide sets Thermite up to stay on one computer: control and one rig run as containers under Docker or Podman, your work is kept in volumes, and you sign in with a token of your own. You install it from a release: one compose file that runs Thermite's published images, so nothing is built on your computer. The guide also covers settings, updates, the port, and what control needs before rigs on other machines can reach it.

[Your first run](../../tutorials/first-run.md) walks through the first start step by step. This page assumes you know what control and a [rig](../../reference/glossary.md) are. To build the images from the source code instead, as people who work on Thermite do, see [Running Thermite locally](https://github.com/iammrduncan/thermite/blob/main/docs/local-development.md).

## Before you start

- A computer running Linux or macOS, with a few CPU cores, a few gigabytes of free memory, and disk space for the images (about 2 GB) and for what your projects build.
- **Docker** with Docker Compose, or **Podman** with `podman compose` or podman-compose. On a Mac, start Podman's virtual machine first (`podman machine start`).
- `curl`, and access to `github.com` and `ghcr.io`, where the release and its images are.

To check the computer before the first `up`, build [the command line](#the-command-line) and run `npx thermite doctor` in its folder. It checks Docker or Podman and the compose tool, port 8800, free disk and the clock, and, on a computer with an NVIDIA GPU, the driver and NVIDIA's container toolkit. Each problem it finds comes with a `Fix:` line. See [Check the machine](../operate/troubleshoot.md#check-the-machine).

## Start it

From a terminal:

```sh
mkdir thermite && cd thermite
curl -fsSLO https://github.com/iammrduncan/thermite/releases/latest/download/compose.yaml
docker compose run --rm init     # or: podman compose run --rm init
docker compose up -d             # or: podman compose up -d
```

- **The release.** Each [release](https://github.com/iammrduncan/thermite/releases) has two files: `compose.yaml` and a short `README.md`. `releases/latest/download/` gets the newest release's; `releases/download/v0.1.0/` gets the files of `v0.1.0`. The compose file's first line names its release, such as `# Thermite 0.1.0`, and it pins each image by its digest, so the same file always runs the same images.
- **The tokens.** `run --rm init` runs the `init` container once. It writes local tokens to `.dev/secrets/`, next to `compose.yaml`, and its last line is `local init: .dev ready` with the number of files it made and kept. Run it before the first `up`: `up` stops with an error about a missing secret file until the tokens are there. It keeps every file that exists, so it is safe to run again. It runs as root in its container, with no network. Where root in a container is root on the computer, as with Docker on Linux, it gives what it makes to the owner of your `thermite` folder, so you can read and change the files.
- **The images.** The first `up` downloads them, which takes a few minutes. Later starts take seconds.

Check that it works:

```sh
docker compose ps                         # or: podman compose ps
curl http://127.0.0.1:8800/v1/health
```

`ps` lists `control`, `harness` and `supervisor` as up, and the health check answers `{"ok":true}`. The dashboard is at <http://127.0.0.1:8800/ui>. To sign in, paste the owner's token: `cat .dev/secrets/control-admin-token` prints it.

On a computer without a screen, reach the dashboard from your own computer through SSH, then open the same address there:

```sh
ssh -L 8800:127.0.0.1:8800 you@host-1
```

### The command line

Some steps below use Thermite's command line. It comes with Thermite's source code: build it once, with **Node.js** 22.19 or later and **git**, in a folder beside your `thermite` folder. Take the source of the release you run (`v0.1.0` here), and link your tokens into it:

```sh
cd ..
git clone --branch v0.1.0 https://github.com/iammrduncan/thermite.git thermite-source
cd thermite-source
ln -s ../thermite/.dev .dev
npm ci
npm run build
```

Run `npx thermite` in your `thermite-source` folder; from another folder, `npx` may fetch some other package of that name. With the link, the guides' paths, such as `--token-file .dev/secrets/control-admin-token`, work there too. The [command line reference](../../reference/command-line.md) lists its commands. The stack doesn't need the command line: each image has its own copy, as `thermite`. Only `thermite doctor`, which checks the computer itself, must run here and not in a container.

## What runs

| Container | What it is |
| --- | --- |
| `control` | The dashboard, the REST API and MCP, on port 8800 |
| `harness` | The rig `local-1`: its judge and its agents, on the CPU. It has no port outside the stack |
| `supervisor` | The rig's link to control. It also does the rig's git work |
| `init` | Makes `.dev/` and your tokens, then stops. `up` runs it too; it finds the files there and keeps them |

`docker compose --profile two-rigs up -d` adds a second CPU rig, `local-2`. The compose stack has no GPU rig: GPU rigs run on other machines ([goal 037](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/037-gpu-compose.goal) plans one under compose).

## Where your data lives

Compose keeps Thermite's state in named volumes. Their names start with the project's name, `thermite`, for example `thermite_control-state`.

| Volume | What it holds |
| --- | --- |
| `control-state` | Control's database, with Thermite's [knowledge base](../../explanation/journals-and-knowledge.md) (a folder for each campaign), its signing key, the key that seals every provider key, and kits written on the New campaign page |
| `control-pub` | Control's public key, which the harness reads |
| `harness-state` | The rig's ledger, its git copies, kits, imports, models and settings, and copies of past research (what earlier runs recorded) for its runs to read |
| `harness-scratch` | Working copies. The harness empties it every time it starts |
| `outbox` | Exports waiting for the supervisor |
| `supervisor-home` | The supervisor's own state |
| `results` | The local results repository. To push to a real one, see [Set up the results repository](../operate/results-repository.md) |

The folder `.dev/`, next to `compose.yaml`, holds the tokens (`.dev/secrets/`), the inbox (`.dev/inbox/`) and the advisors' files (`.dev/advisors/`). The `init` container makes it.

`docker compose down` removes the containers and keeps the volumes. `docker compose down -v` deletes the volumes too, and with them every campaign, result and provider key.

## Use an owner's token of your own

The `init` container writes the owner's token to `.dev/secrets/control-admin-token`, and control reads that file. That is fine on a computer only you use. For a lasting install, make the owner's token yourself and give control only its SHA-256, so control holds nothing that signs in as you. You do this with an override file next to `compose.yaml` (see [Settings and override files](#settings-and-override-files)), so the release's own file stays unchanged.

1. Make the token, with the [command line](#the-command-line):

   ```sh
   npx thermite token new --out ~/thermite-owner-token
   ```

   It writes the token to the file and prints a line with `sha256` and 64 hexadecimal characters: the hash. Keep the token somewhere safe, such as a password manager.

2. Make a file named `compose.tokens.yaml` next to `compose.yaml`, with your hash:

   ```yaml title="compose.tokens.yaml"
   services:
     control:
       environment:
         THERMITE_CONTROL_ADMIN_TOKEN_FILE: ""
         THERMITE_CONTROL_ADMIN_TOKEN_SHA256: "<the 64 characters>"
   ```

   The empty `_FILE` line turns the token file off. Control refuses to start when both settings are set.

3. Empty the old token file:

   ```sh
   : > .dev/secrets/control-admin-token
   ```

   Leave the empty file in place: compose still mounts it.

4. Start the stack with both files:

   ```sh
   docker compose -f compose.yaml -f compose.tokens.yaml up -d   # or: podman compose -f … -f … up -d
   ```

   Sign in with your new token. Every earlier dashboard session has ended.

From now on, name `compose.tokens.yaml` in every `up` command, as [Settings and override files](#settings-and-override-files) says. Without it, control finds the empty file and stops at every start (compose keeps restarting it), so the dashboard doesn't answer. Its log (`docker compose logs control`) says `control needs the owner's credential`.

The stack also gives control an operator token, from `.dev/secrets/control-operator-token`, for an agent over MCP. To replace it with a hash or turn it off, use the same override file: see [Make and change tokens](../operate/tokens.md).

## Settings and override files

Put settings in a file named `.env` next to `compose.yaml` (git ignores it), then run `docker compose up -d`. `.env` reaches only the settings that `compose.yaml` passes on:

| Container | The settings `.env` reaches |
| --- | --- |
| `control` | `THERMITE_CONTROL_PUBLIC_URL`, `THERMITE_RIG_HARNESS_IMAGE`, `THERMITE_RIG_HARNESS_CUDA_IMAGE`, `THERMITE_RIG_SUPERVISOR_IMAGE`, `THERMITE_CONTROL_REQUIRE_KEY_ACCEPT`, `THERMITE_CONTROL_SESSION_DAYS`, `THERMITE_CONTROL_STALE_SECONDS`, `THERMITE_CONTROL_OFFLINE_SECONDS`, `THERMITE_LIFECYCLE` |
| `harness` | `THERMITE_PROMOTION`, `THERMITE_CALIBRATION_BLOCKS`, `THERMITE_MODEL_BASE_URL`, `THERMITE_MODEL`, `THERMITE_MODEL_CONTEXT_WINDOW`, `THERMITE_MODEL_MAX_TOKENS`, `THERMITE_MODEL_REASONING_EFFORT`, `THERMITE_MAX_TRIALS`, `THERMITE_TRIAL_MINUTES`, `THERMITE_MAX_TURNS`, `THERMITE_RESEARCH_MAX_MB`, `THERMITE_LLM_USD_PER_MTOK_IN`, `THERMITE_LLM_USD_PER_MTOK_OUT`, `THERMITE_EXPORT_MINUTES` |
| `supervisor` | `THERMITE_POLL_SECONDS`, `THERMITE_COMMAND_POLL_SECONDS`, `THERMITE_MODEL_ROUTE_POLL_SECONDS`, `THERMITE_LIVE_INTERVAL_MS`, `THERMITE_RESULTS_REMOTE`, `THERMITE_ADVISORS_FILE` |
| Compose itself | `THERMITE_CONTROL_PORT`, `THERMITE_COMMIT` for the images' builds, and `THERMITE_ENGINE_SOCKET_HOST` for `compose.lifecycle.yaml` |

The [settings reference](../../reference/settings.md#the-compose-file) gives their defaults, and the few that the second rig of `two-rigs` leaves out.

Any other setting needs an **override file**: a second compose file next to `compose.yaml` that adds lines to a container. The guides make these:

| File | Made in | What it adds |
| --- | --- | --- |
| `compose.tokens.yaml` | [Use an owner's token of your own](#use-an-owners-token-of-your-own) | Control's token settings |
| `compose.claude.yaml` | [Use a Claude subscription](../models/claude-subscription.md#2-build-the-images-with-claude-code) | Claude Code in the harness and supervisor images. It builds them from the source code: the published images never carry Claude Code |
| `compose.model.yaml` | [Connect a model provider](../models/connect-a-provider.md#use-the-rigs-own-settings-instead) | Model settings that `compose.yaml` doesn't pass, such as `THERMITE_AGENT_HARNESS` |
| `compose.harness.yaml` | [Extend the harness image](extend-harness-image.md#on-the-local-stack) | Your own harness image for the local rig |
| `compose.results.yaml` | [Set up the results repository](../operate/results-repository.md#3-give-the-supervisor-the-three-settings) | The results repository's key files |
| `compose.lifecycle.yaml` | In the repository, beside the source code's own `compose.yaml`: see [Give control a deployment driver](../operate/rig-lifecycle.md#give-control-a-deployment-driver) | Rig restarts by control, for development |

For a setting that no guide covers, such as `THERMITE_RUNPOD_TEST_IMAGE` on control, write a file of your own the same way:

```yaml title="compose.local.yaml"
services:
  control:
    environment:
      THERMITE_RUNPOD_TEST_IMAGE: registry.example.com/thermite/thermite-harness:1a2b3c4d5e6f-cuda
```

**Name every override file you use in every later `up`,** each with `-f`, after `-f compose.yaml`. That includes the `up` after an update. Compose reads only the files it is given, so a start that leaves one out drops what that file adds. For example, with all of them:

```sh
docker compose -f compose.yaml -f compose.tokens.yaml -f compose.claude.yaml \
  -f compose.model.yaml -f compose.harness.yaml -f compose.results.yaml \
  -f compose.lifecycle.yaml -f compose.local.yaml up -d
```

Name only the files you made. With Podman, write `podman compose` in place of `docker compose`.

### The port

If port 8800 is taken on this computer, choose another:

```sh title=".env"
THERMITE_CONTROL_PORT=8801
```

The dashboard is then at `http://127.0.0.1:8801/ui`. Inside the stack, control keeps port 8800.

## Stop, start and update

- **Stop:** `docker compose down`. **Start:** `docker compose up -d`, with your `-f` options.
- Each container restarts by itself if it stops (`restart: unless-stopped`). Thermite ships nothing that starts the stack again after the computer restarts ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). Docker starts the containers again when its own service starts; on Linux, `sudo systemctl enable docker` starts that service at boot. With Podman, start the stack again yourself after a restart: on a Mac `podman machine start` first, then your `up -d` command.
- **Update** to the newest release. Read its notes on the [releases page](https://github.com/iammrduncan/thermite/releases) first: 0.x releases make no promise that an update keeps everything working. Then, in your `thermite` folder:

  ```sh
  curl -fsSLO https://github.com/iammrduncan/thermite/releases/latest/download/compose.yaml
  docker compose run --rm init     # or: podman compose run --rm init
  docker compose up -d             # or: podman compose up -d
  ```

  Add your `-f` options to the last line, as in [the example above](#settings-and-override-files). `curl` replaces `compose.yaml` with the new release's. `init` keeps every token file that exists, the empty owner's file too, and adds any file a newer version needs. `up` downloads the new images and replaces the containers whose images changed. The volumes stay. When the harness restarts, running trials and judge jobs start again. If you built the [command line](#the-command-line), take the same release there: in `thermite-source`, `git fetch --tags`, then `git checkout` the new tag, `npm ci` and `npm run build`.

After an update, run the rig's **Judge smoke** check ([Check a rig](../operate/check-a-rig.md)). This updates only the local stack. Rigs elsewhere keep the images they run:

- a rig that control set up on a cluster moves onto new images from its page. Control deploys the new release's images once it runs from the new `compose.yaml`, unless `.env` names other images ([Move a rig onto new images](../operate/rig-lifecycle.md#a-rig-on-a-cluster));
- a rig on another machine, or one you joined yourself, can't be moved yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).

## Let rigs on other machines reach control

A rig on another machine or a cluster reports to control by connecting to it. That takes a name for control that the rigs reach over HTTPS, a reverse proxy on this computer, and rig images that the rigs can pull without signing in. The release's published images are such images, and its compose file gives them to control already. **Rigs › Add a rig** (**Rigs** is in the sidebar on the left) needs three things, and shows what is missing:

1. **An HTTPS address the rigs can reach.** Compose publishes control on `127.0.0.1` only, so nothing outside this computer reaches it. Put a reverse proxy on this computer in front of `127.0.0.1:8800` (or the port you chose) that serves HTTPS under a name the rigs can reach, such as `control.example.com`. Thermite doesn't include a proxy or its configuration: use one you know. Have the proxy:
   - send `X-Forwarded-Proto: https`, so control marks the dashboard's sign-in cookie as secure;
   - accept request bodies of up to 64 MB: rigs send champions' patches, and the New campaign page kit archives, of up to that size.

   Nothing streams: the live view asks control every two seconds, and MCP answers in plain JSON.
2. **That address, in control's settings.** In `.env`:

   ```sh title=".env (part)"
   THERMITE_CONTROL_PUBLIC_URL=https://control.example.com
   ```

3. **The images control sets rigs up from**, in a registry the rigs can pull from. The release's `compose.yaml` sets them to the release's own images on `ghcr.io`, pinned by digest: the CPU harness, the CUDA harness and the supervisor. So with the release's file there is nothing to do. To use images of your own instead ([Push the images to your own registry](own-registry.md)), name them in `.env`:

   ```sh title=".env (part)"
   THERMITE_RIG_HARNESS_IMAGE=registry.example.com/thermite/thermite-harness:1a2b3c4d5e6f
   THERMITE_RIG_HARNESS_CUDA_IMAGE=registry.example.com/thermite/thermite-harness:1a2b3c4d5e6f-cuda
   THERMITE_RIG_SUPERVISOR_IMAGE=registry.example.com/thermite/thermite-supervisor:1a2b3c4d5e6f
   ```

   The CUDA image is needed only for GPU rigs.

Run `docker compose up -d`, with your `-f` options, to restart control with them.

To tell that it worked:

- From another machine, `curl https://control.example.com/v1/health` answers `{"ok":true}`.
- **Rigs › Add a rig** no longer says "Control has no rig images configured" or "Control's address for rigs is not set", and its **Images** field lists the images.

Next: [Add a rig on a machine over SSH](rig-on-a-machine.md), [on a Kubernetes cluster](rig-on-a-cluster.md), or [join one yourself](join-a-rig.md).
