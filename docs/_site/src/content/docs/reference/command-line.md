---
title: "Command line"
description: "Every thermite command and option, where it runs, what it prints and its exit codes, and thermite-trial inside the harness image."
type: reference
sidebar:
  order: 5
---

`thermite` is Thermite's command line. It checks the machine it runs on, checks contracts, makes tokens, starts runs and sends [signed commands](signed-commands.md) through control, enrolls rigs, and talks to a rig's harness. The harness image also holds `thermite-trial`, the command a worker agent uses from its own shell.

```sh
npx thermite contract validate contract.json
npx thermite command --control https://control.example.com --token-file ~/thermite-owner-token \
  --rig rig-1 --kind pause_run --payload '{"run":"run-1","reason":"checking the kit"}'
```

The first prints `ok`, the contract's mode, name, version and SHA-256. The second prints the new command's id and `"status":"pending"`. For the steps around these commands, see [Start a campaign from the command line](../how-to/campaigns/start-from-command-line.md) and [Make and change tokens](../how-to/operate/tokens.md). The words [control](glossary.md), [rig](glossary.md), [harness](glossary.md) and [run](glossary.md) are in the glossary.

## Where it runs

| Where | How to run it | Used there for |
| --- | --- | --- |
| Your computer, in a clone of the repository | `npx thermite <command>`, after `npm ci` and `npm run build`. It runs `dist/cli/thermite.js` and needs Node.js 22.19 or later. With a release's compose stack, link its `.dev/` folder into the clone, as [the command line](../how-to/install/one-machine.md#the-command-line) shows | Checking the machine, contracts, tokens, starting runs, commands, enrolling rigs |
| Control's image | `thermite` (`/usr/local/bin/thermite`, which runs `node /opt/thermite/dist/cli/thermite.js`) | The same commands, from inside control's container, except `doctor`, which checks the machine it runs on. A release's `init` service runs `local init` from this image |
| The supervisor's image | `thermite`, the same wrapper | The same commands |
| The harness image | `thermite`, the same wrapper, and `thermite-trial` | `submit` and `status` against the harness at `http://127.0.0.1:8700`; `selftest isolation`, which must run there, as root |

Under the local compose stack the harness publishes no port, so `submit`, `status` and `selftest isolation` run inside the harness container, for example with `docker compose exec harness thermite selftest isolation`.

## Usage

`thermite`, `thermite help` and `thermite --help` print this text and exit 0:

```text
usage: thermite <command> [options]

  doctor [--control URL] [--model-url URL] [--port N] [--json]
                                      check this machine: the container engine and its compose
                                      tool, control's port, disk, the clock, the GPU driver and
                                      container toolkit where there is a GPU, and whether control
                                      and the model server answer. It says how to fix each
                                      problem, and exits 1 when a check fails
  contract validate <file>            validate a contract and print its sha256
  keys generate <dir>                 write a new Ed25519 control signing key pair
  token new --out F                   make a control token: write it to F (mode 0600; keep it,
                                      for example in a password manager) and print its SHA-256,
                                      the only part control's deployment needs
  assign --contract F --run ID [--seed GIT_URL[@COMMIT] | --seed-commit C] [--kit GIT_URL]
         [--model NAME=URL ...] [--direction D] [--agents off] [--promotion auto|owner]
         [--queue-from [RIG/]RUN]
         (--control URL --token-file F --rig R [--ttl MIN] | --print)
                                      start a run. The rig's supervisor fetches the project and
                                      kit commits from their repositories, and models from their
                                      URLs, before the harness checks them. --seed-commit names a
                                      commit already on the rig (an earlier run's result); a kit
                                      already there needs no --kit. --queue-from starts the new
                                      run's queue with a past run's untried experiments, read
                                      from control (on --rig unless RIG/ is given; it needs
                                      --control and --token-file, with --print too). --print
                                      shows the payload (for issue_command over MCP) instead of
                                      issuing it
  assign-payload --contract F --run ID --seed-repo R --seed-commit C --bundle PATH
                 [--bundle-sha256 H] [--kit-repo R --kit-commit C --kit-bundle PATH
                 [--kit-bundle-sha256 H]] [--model NAME=SHA256:PATH ...] [--direction D] [--agents off]
                                      print an assign_campaign payload (bundle and model
                                      paths are relative to the rig's inbox)
  rig add RIG --control URL --token-file F --out DIR
                                      enroll a rig with control (owner's token): control makes
                                      its token, and DIR gets the files the rig's host needs
  rig token RIG --control URL --token-file F --out FILE
                                      give an enrolled rig a new token (the old one stops working)
  rig retire RIG --control URL --token-file F
                                      shut an enrolled rig out of control; its history stays
  rig list --control URL --token-file F [--json]
                                      list the rigs (owner's token): reporting, stale or
                                      offline, and each one's Thermite version against
                                      control's, with what to do when it is behind or refused
  runpod launch CLOUD --gpu G [--gpus N] [--cloud-type SECURE|COMMUNITY] [--datacenter DC]
         [--image I] [--disk GB] [--volume GB] [--rig NAME] [--enroll-within MIN]
         [--setting NAME=VALUE ...] [--spend-limit USD] [--idle-stop MIN]
         --control URL --token-file F
                                      spends money: launch a rig on the GPU cloud CLOUD from
                                      Providers (owner's token), a pod of the one-container rig
                                      image in pull mode. Defaults: 1 GPU, SECURE, any data
                                      center, control's rig image, a 40 GB disk, a 100 GB
                                      volume, no spend limit, no idle stop
  runpod list [CLOUD] --control URL --token-file F [--json]
                                      list the rigs launched on GPU clouds (owner's token):
                                      each pod's status, price per hour, spend so far and limits
  runpod limits RIG [--spend-limit USD|off] [--idle-stop MIN|off] --control URL --token-file F
                                      set or clear a RunPod rig's spend limit and idle stop
                                      (owner's token)
  runpod stop RIG --control URL --token-file F
                                      stop a RunPod rig's pod (owner's token): its runs paused
                                      and its results sent out first; its volume stays
  runpod start RIG --control URL --token-file F
                                      start a stopped pod again, and resume the runs its stop
                                      paused; refused when RunPod has no GPU free (owner's token)
  runpod restart RIG --control URL --token-file F
                                      stop the pod and start it again (owner's token)
  runpod terminate RIG --control URL --token-file F
                                      remove the pod for good, once every result has left it;
                                      refused, with the pod kept running, when one can't leave
                                      (owner's token)
  runpod reset RIG --control URL --token-file F
                                      start a full reset of a RunPod rig: every result out,
                                      then the wipe after your confirmation (owner's token)
  runpod confirm-wipe RIG --control URL --token-file F
                                      confirm the wipe of the rig's full reset (owner's token)
  runpod cancel-reset RIG --control URL --token-file F
                                      cancel the rig's full reset before its wipe (owner's token)
  command --control URL --token-file F --rig U --kind K --payload JSON|@file [--ttl MIN]
                                      issue a signed command through control (admin token)
  submit --harness URL --token-file F --run ID --patch-file P --hypothesis TEXT
         [--known-flaw TEXT ...]      submit a patch as a proposer
  status --harness URL --token-file F --attempt ID
                                      show an attempt's lifecycle and verdict
  local init DIR                      make DIR, the local compose stack's .dev folder: random
                                      tokens in DIR/secrets, the inbox, the outbox and the
                                      advisors' folder. Files that exist are kept. Run as root,
                                      it gives what it makes to the owner of DIR's parent folder
  selftest isolation [--force]        inside the harness container, as root, with the rig idle: check that role
                                      users cannot reach the ledger, kits, builds or secrets
```

## Rules for every command

- **Options.** Each option takes its value as the next word or after `=`. In `doctor`, `token new`, `assign`, `assign-payload`, `rig`, `runpod`, `command`, `submit` and `status`, an option the command does not know, or a word it does not expect, ends the command with Node's own message and exit code 2.
- **Older option names.** `--instance` is read as `--run`, and `--unit` as `--rig`. These are the names from before runs and rigs were renamed.
- **Control's token.** The commands that talk to control (`assign`, `command`, `rig add`, `rig token`, `rig retire`, `rig list`, and every `runpod` command) send the contents of `--token-file`, trimmed, as `Authorization: Bearer <token>`. Only the owner's token works on these routes; any other token gets `401 {"error":"unauthorized"}`. See [Tokens and roles](tokens.md).
- **Control's address.** `--control` is control's base address, such as `https://control.example.com`. A trailing `/` is removed.
- **Refusals.** When control or the harness refuses a request, the command prints `<url> -> <status> <body>` on standard error and exits 2. `status` is the exception: see [below](#status). A request body that does not match the route gives `400 {"error":"invalid request"}`; a command that control refuses before signing it gives `400` with the reason (for example a payload that does not fit its kind, or a message that nothing would read), or `404` for an unknown rig; another refusal from inside control gives `500` with the reason. The [REST API reference](rest-api.md) lists the routes.

### Exit codes

| Code | When |
| --- | --- |
| `0` | The command did its work. Also `thermite`, `help` and `--help` |
| `1` | `doctor` found a check that failed; `contract validate` found the contract invalid; `selftest isolation` found a probe that was not refused |
| `2` | Missing or wrong options (the usage text goes to standard error); an unknown command (the usage text goes to standard output); a refused request; any other error, with its message on standard error |

## Commands

### `doctor`

`thermite doctor` checks the machine it runs on, before control or a rig starts there: the container engine and its compose tool, control's port, free disk, the clock, the GPU driver and NVIDIA's container toolkit where there is a GPU, and whether control and the model server answer. Each check says what it found, and a check that failed or warns says how to fix it. It changes nothing on the machine. Run it on the machine itself, not inside a container: it checks that machine's engine and disks. [Troubleshoot](../how-to/operate/troubleshoot.md#check-the-machine) says when to run it.

```sh
npx thermite doctor --control https://control.example.com --model-url https://opencode.ai/zen/v1
```

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--control URL` | No | | Control's address. The doctor checks that this machine reaches control, and compares this machine's clock with control's. On a rig's machine, give control's address for rigs. A trailing `/` is removed |
| `--model-url URL` | No | | The model server's address: the provider's base URL, as on **Settings › Providers**. `host.docker.internal` and `host.containers.internal`, the containers' names for this machine, are checked at `127.0.0.1` |
| `--port N` | No | `THERMITE_CONTROL_PORT`, else `8800` | Control's port on `127.0.0.1`, as the compose file publishes it: a whole number from 1 to 65535. Otherwise: `--port is a port number from 1 to 65535`, exit 2 |
| `--json` | No | | Print `{"ok": true or false, "checks": [...]}` instead of text. Each check has `check`, `title`, `status`, `said` and, for a failure or a warning, `fix` |

The checks, in the order it runs them:

| Check (`check`) | What it looks at | Fails when | Warns when | Skipped when |
| --- | --- | --- | --- | --- |
| Container engine (`engine`) | `docker --version` and `docker info`; `podman --version` and `podman info`. A `docker` command that is Podman's stand-in counts as Podman | Neither is installed, or none answers. The fix depends on the engine and the system, such as `podman machine start` on a Mac | | |
| Compose tool (`compose`) | For each engine that answers: `docker compose version`, else `docker-compose version`; `podman compose version`, else `podman-compose version` | No compose tool works | | No engine answers |
| Control's port (`port`) | Whether a program listens on `127.0.0.1` at the port. If one does, whether it is control: `GET /v1/health`. A rig listens on no port of its own on its machine; it needs to reach control's port, which the **Control** check tests | Another program has the port | | |
| Disk (`disk`) | Free space for the engine's images: Podman's own numbers (`podman info`), or on Linux the file system of Docker's root folder. Free space in the current folder | Under 5 GB for the images, or under 1 GB in the folder | Under 15 GB for the images, or under 5 GB in the folder | Neither can be read. Docker Desktop's own disk can't be read: the check says where to look |
| Clock (`clock`) | With `--control`: control's `Date` header. Without it, on Linux: `timedatectl`, whether the system says its clock is synchronized | More than 300 s from control's clock. Control refuses a rig's reports from more than 5 minutes ahead | More than 30 s from control's clock, or not synchronized | Without `--control` on macOS, or on Linux without `timedatectl`; or when control does not answer |
| GPU driver (`gpu-driver`) | On Linux, with an NVIDIA GPU (`/dev/nvidia0`, `/proc/driver/nvidia/gpus`, or an NVIDIA display controller in `lspci`): `nvidia-smi` | `nvidia-smi` is missing or fails | | No NVIDIA GPU, or macOS |
| GPU container toolkit (`gpu-toolkit`) | `nvidia-ctk --version`, and a CDI spec at `/etc/cdi/nvidia.yaml` or `/var/run/cdi/nvidia.yaml` | Either is missing | | No NVIDIA GPU, or macOS |
| Control (`control`) | `GET /v1/health` at `--control` | No answer, or an answer that is not control's | | No `--control` |
| Model server (`model`) | `GET` at `--model-url`. Any HTTP answer counts, even `401` or `404`: the rig's [Model route check](rig-checks.md) tests the model itself | No answer | | No `--model-url` |

A request waits at most 10 seconds. A failed request says why: nothing listens at the address, the name does not resolve, no answer in time, or a TLS certificate this machine does not trust.

The text report has one line for each check. The line starts with `ok`, `WARN`, `FAIL` or `skip`, then the check's name and what it found. A failure or a warning has a second line, `Fix:` and what to do:

```text
ok    Container engine: Podman 5.2.1 answers.
ok    Compose tool: podman compose works.
FAIL  Control's port: Port 8800 is in use by another program. Control needs this port for its dashboard and API.
      Fix: Stop that program. To find it, run lsof -nP -iTCP:8800 -sTCP:LISTEN. Or use another port: put THERMITE_CONTROL_PORT=8801 in a .env file next to compose.yaml. Then run thermite doctor --port 8801.
ok    Disk: 47.1 GB is free for Podman's images in its virtual machine. 306.2 GB is free in this folder.
skip  Clock: Give --control to compare this clock with control's clock.
```

The last line counts them: `No check failed.` and the number of warnings, or the number of failed checks and warnings, then `Fix the failures, then run thermite doctor again.` The command exits 0 when no check failed, whatever the warnings and skipped checks, and 1 when one failed.

### `contract validate`

`thermite contract validate <file>` parses a [contract](contract.md) with the same schema control and the harness use. It needs no network.

| Result | Output | Exit |
| --- | --- | --- |
| Valid | `ok <mode> <campaign> v<version> sha256=<hex>` on standard output | `0` |
| Valid, but a hill climb or goal contract names no `project.kit` | The `ok` line, then on standard error: `warning: no project.kit: the judge cannot measure this campaign until the contract names a kit repository and commit` | `0` |
| Invalid | One line per problem on standard error | `1` |
| Not JSON, or no such file | The error on standard error | `2` |

The SHA-256 is the contract's hash: an `assign_campaign` command carries it as `contract_sha`.

### `keys generate`

`thermite keys generate <dir>` writes a new Ed25519 key pair for signing commands: `<dir>/control-signing.key` (mode 0600) and `<dir>/control-signing.pub` (mode 0644). It creates `<dir>` if needed and prints `wrote <dir>/control-signing.{key,pub}`.

Control makes its own pair in its data directory the first time it starts, so it does not need this command.

### `token new`

`thermite token new --out F` makes a token for control: 32 random bytes, written base64url-encoded to `F` with mode 0600.

| Option | Required | Meaning |
| --- | --- | --- |
| `--out F` | Yes | The file to write. An existing file is never overwritten: `F exists; a token is never overwritten` |

It prints:

```text
wrote the token to F
sha256 <64 hexadecimal characters>
Deploy control with the hash as THERMITE_CONTROL_<ROLE>_TOKEN_SHA256, where ROLE is ADMIN (the owner), OPERATOR, AGENT or READ.
```

The hash is what control's settings take; the token itself stays with you. See [Tokens and roles](tokens.md).

### `assign`

`thermite assign` builds an `assign_campaign` command from a contract and sends it to a rig through control, or prints it. The rig's [supervisor](glossary.md) fetches what the command names, and the harness checks it and starts the run.

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--contract F` | Yes | | The contract file. It is checked before anything is sent; an invalid contract ends the command with its problems (exit 2) |
| `--run ID` | Yes | | The new run's id: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64 characters. Control refuses another form with `bad assign_campaign payload: run: lowercase id` |
| `--seed GIT_URL[@COMMIT]` | No | | The project's repository, and the commit to start from. `COMMIT` is a full commit id (40 or 64 hexadecimal characters). Without `@COMMIT`, the contract's `project.commit` is used. The supervisor fetches that commit from the repository |
| `--seed-commit C` | No | The contract's `project.commit` | A full commit id that is already on the rig, such as an earlier run's result. Nothing is fetched |
| `--kit GIT_URL` | No | | The [kit](glossary.md)'s repository. The kit's commit comes from the contract's `project.kit`. Without `--kit`, the kit's commit must already be on the rig |
| `--model NAME=URL` | No, repeatable | | A [model file](glossary.md) the contract lists under `models` (a data file the project loads, such as a model's weights), and an `http` or `https` address to fetch it from |
| `--direction D` | No | | Text kept with the run as `direction`. Thermite does not act on it |
| `--agents on\|off` | No | `on` | `off` starts a judge-only run: no worker agents, the judge still works |
| `--promotion auto\|owner` | No | The rig's own setting | The run's promotion rule. `owner` is sent as `owner_approval`: every confirmed win waits for the owner |
| `--queue-from [RIG/]RUN` | No | Off: the new run's queue starts empty | A past run whose untried experiments start the new run's [experiment queue](../how-to/campaigns/choose-what-runs-next.md). `RUN` alone is a run on `--rig`; `RIG/RUN` names its rig. They are read from control, so it needs `--control` and `--token-file`, with `--print` too. See [below](#copy-a-past-runs-untried-experiments) |
| `--control URL` | To send it | | Control's address |
| `--token-file F` | To send it | | A file with the owner's token |
| `--rig R` | To send it | | The rig that runs it |
| `--ttl MIN` | No | `60` | Minutes before the command expires if the rig has not taken it: a whole number from 1 to 10080 (7 days) |
| `--print` | Instead of the four above | | Print the payload as indented JSON and send nothing. The output is what the MCP tool `issue_command` takes as `payload` |

`--seed` and `--seed-commit` together are refused. When the contract's project is one folder of its repository (`project.folder`), `--seed` and `--seed-commit` still name the whole repository and its commit: the harness starts the run from that folder of the commit. For a research contract, the run has no seed and no kit, and `--seed`, `--seed-commit` and `--kit` are not used.

#### Copy a past run's untried experiments

`--queue-from` puts the same experiments in the payload's `queue` as **Copy the untried experiments of** in a campaign's **Start a run** panel: the past run's experiments up next, in their order, then its lanes' ideas, at most 500. The tried and dropped ones stay with their run. The command reads them from control (`GET /v1/rigs/<rig>/runs/<run>/untried`, see [the REST API](rest-api.md#rigs-and-their-history)) before it sends or prints anything. Control takes each one's title, details, direction, why and author from its own records of the past run, with every edit, as for a copied experiment over MCP. That holds for a run of the contract's campaign, or of a campaign whose folder it may read; any other run's experiments keep their words, with the author `copied`. Each one names where it came from, as `from: {run, id}`.

```sh
npx thermite assign --contract contract.json --run sort-speed-3 --seed-commit 0123456789abcdef0123456789abcdef01234567 \
  --queue-from sort-speed-2 \
  --control https://control.example.com --token-file ~/thermite-owner-token --rig rig-1
```

A past run with nothing untried leaves the queue empty: the command says `<run> on <rig> has no untried experiments: the new run's queue starts empty` on standard error, sends no `queue`, and goes on.

The imports it adds to the payload:

| Option | Import | `path` in the rig's inbox | `source` |
| --- | --- | --- | --- |
| `--seed` | `repo_bundle` for the contract's `project.repo` and the seed commit | `repos/<repo>-<commit>.bundle` | `{"git": "<GIT_URL>"}` |
| `--kit` | `kit_bundle` for the contract's `project.kit` repository and commit | `repos/kit-<repo>-<commit>.bundle` | `{"git": "<GIT_URL>"}` |
| `--model` | `model` with the contract's SHA-256 for that model | `models/<sha256>` | `{"url": "<URL>"}` |

Sent, it prints control's answer on one line, such as `{"id":"<command id>","status":"pending"}`. [Signed commands](signed-commands.md) describes the `assign_campaign` payload and what the harness checks. The campaign's page on the dashboard can start further runs of it: **Start a run** signs the newest assignment again as a new run, with the same contract, seed and imports. A run on another rig works only if that rig already has what the imports leave out: the seed commit when `--seed` was not given, the kit's commit when `--kit` was not given, and each model the contract lists that no `--model` gave.

| Message | Cause |
| --- | --- |
| `give --control, --token-file and --rig to issue it, or --print to show it` | Neither the three options nor `--print` |
| `--seed or --seed-commit, not both` | Both were given |
| `the seed commit must be a full commit id (40 or 64 hexadecimal characters)` | `--seed` without a full `@COMMIT`, and the contract's `project.commit` is not one either |
| `--seed-commit must be a full commit id (40 or 64 hexadecimal characters)` | The commit from `--seed-commit` or the contract is not a full commit id |
| `--kit given, but the contract names no project.kit` | `--kit` with a contract that has no kit |
| `--model <arg>: expected NAME=URL for a model the contract lists` | No `=`, or a name the contract's `models` does not list |
| `--agents is on or off` | Another value |
| `--promotion is auto or owner` | Another value |
| `a run without agents has no queue: leave out --queue-from` | `--queue-from` with `--agents off`. The harness refuses such a payload the same way |
| `--queue-from reads the past run from control: give --control and --token-file` | `--queue-from` without either |
| `--queue-from RUN is a run on --rig: give --rig, or RIG/RUN` | `--queue-from` with a run alone and no `--rig` |
| `--queue-from names a run: RUN or RIG/RUN` | An empty run or rig name, such as `rig-1/` |
| `<url> -> 404 {"error":"no run <run> on <rig>"}` | Control has no such run on that rig; `no rig <rig>` for a rig it does not know |

### `assign-payload`

`thermite assign-payload` prints an `assign_campaign` payload, on one line, for bundles and models that are already in the rig's inbox. It does not talk to control. Paths are relative to the inbox.

| Option | Required | Meaning |
| --- | --- | --- |
| `--contract F` | Yes | The contract file |
| `--run ID` | Yes | The new run's id |
| `--seed-repo R` | Yes | The project's repository name |
| `--seed-commit C` | Yes | The full commit to start from: `--seed-commit must be a full commit id (40 or 64 hexadecimal characters)` otherwise |
| `--bundle PATH` | Yes | The project's git bundle in the inbox (a `repo_bundle` import) |
| `--bundle-sha256 H` | No | The bundle file's SHA-256, checked as well as the commit |
| `--kit-repo R`, `--kit-commit C`, `--kit-bundle PATH` | No, together | The kit's bundle in the inbox (a `kit_bundle` import) |
| `--kit-bundle-sha256 H` | No | The kit bundle's SHA-256 |
| `--model NAME=SHA256:PATH` | No, repeatable | A model file in the inbox, with its SHA-256: `bad --model <arg>; expected NAME=SHA256:PATH` otherwise |
| `--direction D` | No | As for `assign` |
| `--agents on\|off` | No | As for `assign` |

It has no `--promotion`; the run takes the rig's own promotion rule.

### `rig add`

`thermite rig add RIG --control URL --token-file F --out DIR` enrolls a rig with control (`POST /v1/rigs`) and writes the files the rig's host needs into `DIR`. Control makes the rig's token and keeps only its SHA-256.

| Option | Required | Meaning |
| --- | --- | --- |
| `RIG` | Yes | The rig's name: 2 to 40 characters of `a`–`z`, `0`–`9` and `-`, starting and ending with a letter or digit. Control refuses another name with `400 {"error":"invalid request"}` |
| `--control URL` | Yes | Control's address |
| `--token-file F` | Yes | A file with the owner's token |
| `--out DIR` | Yes | An empty or new directory. Otherwise: `DIR is not empty; a rig's files are never overwritten` |

It prints `enrolled RIG; control's key fingerprint <fingerprint>`, then `wrote` and each file:

| File | Mode | Holds | Read by |
| --- | --- | --- | --- |
| `secrets/control-rig-token` | 0600 | The rig's token for control | The supervisor, as `THERMITE_CONTROL_TOKEN_FILE` |
| `secrets/harness-supervisor-token` | 0600 | A new token the command makes itself. Control never sees it | The harness, as `THERMITE_SUPERVISOR_TOKEN_FILE`, and the supervisor, as `THERMITE_HARNESS_TOKEN_FILE` |
| `keys/control-signing.pub` | 0644 | Control's public key | The harness, as `THERMITE_CONTROL_PUBKEY_FILE` |
| `keys/control-signing.fingerprint` | 0644 | That key's fingerprint | You, to compare with the fingerprint control's dashboard shows |
| `rig.env` | 0644 | `THERMITE_RIG_ID=<rig>` and `CONTROL_URL=<control's address>` | The rig's settings |
| `README.txt` | 0644 | What each file is for | You |

Control refuses a name that is taken: `409 {"error":"rig <rig> is already enrolled"}`, or `rig <rig> has its token in control's rig tokens file; change it there` for a rig listed in that file.

No token is printed. Thermite has no ready-made deployment that starts a rig from this directory; the dashboard's **Add a rig** sets rigs up for you. See [Add a rig on a machine over SSH](../how-to/install/rig-on-a-machine.md) and [Join a rig yourself](../how-to/install/join-a-rig.md).

### `rig token`

`thermite rig token RIG --control URL --token-file F --out FILE` gives an enrolled rig a new token (`POST /v1/rigs/RIG/token`) and writes it to `FILE` with mode 0600. The old token stops working at once.

It prints `RIG has a new token, in FILE; its old token no longer works`. An existing `FILE` is never overwritten: `FILE exists; a token is never overwritten`. Control refuses a rig it did not enroll: `404 {"error":"rig <rig> is not enrolled"}`, or `409` with `rig <rig> has its token in control's rig tokens file; change it there`.

### `rig retire`

`thermite rig retire RIG --control URL --token-file F` retires a rig (`POST /v1/rigs/RIG/retire`): its token stops working, and its history stays on control. It works on any rig control knows: enrolled, listed in the rig tokens file, or one that has reported. It prints `RIG is retired: its token no longer works`. A rig control does not know gives `404 {"error":"no rig <rig>"}`.

### `rig list`

`thermite rig list --control URL --token-file F` lists the rigs (`GET /v1/rigs`): whether each one reports, and its Thermite version against control's. `--json` prints control's answer as it is instead.

```text
control 0.2.0 (1a2b3c4d5e6f), protocol 1
RIG    STATE      LAST REPORT               VERSION  HARNESS               SUPERVISOR
rig-1  reporting  2026-10-20T12:00:00.000Z  behind   0.1.0 (abcdef012345)  0.1.0 (abcdef012345)
  This rig runs an older Thermite than control: harness 0.1.0, supervisor 0.1.0. Control runs 0.2.0. Control still works with it. Update the rig's images.
rig-2  offline    never                     refused  no version            0.1.0
  Control cannot work with this rig: its supervisor speaks protocol 0, and control works with protocol 1. Update the rig's images.
rig-3: enrolled, no report yet
```

- **The first line** is control's build: its version, the first 12 characters of its commit when its image has one, and its protocol. `(works with 1 to 2)` follows when control works with older protocols too.
- **`STATE`** is `reporting`, `stale` or `offline`. **`LAST REPORT`** is `never` for a rig that never sent one.
- **`VERSION`** is `current`, `behind`, `ahead`, `unknown` or `refused`. Under a rig that is not `current`, an indented line says what to know and do.
- **`HARNESS`** and **`SUPERVISOR`** are the version each part reports, with its commit, or `no version` for a part from before version checks.
- **Enrolled rigs** that never reported come last.

[Rig versions](rest-api.md#rig-versions) says what each state means and when control refuses a rig. Against a control from before version checks, the first line is `control: no version (control is older than version checks)`, and each rig's state and version are `unknown`.

### `runpod launch`

`thermite runpod launch CLOUD` **spends money**. It launches a rig on the GPU cloud `CLOUD` from **Providers** (`POST /v1/gpu-clouds/CLOUD/rigs`): one pod of the [one-container rig image](harness-image.md#the-one-container-rig-image), in [pull mode](../explanation/trust.md#rigs-in-pull-mode), billed by the hour until it is stopped or removed. Only the owner's token may launch. Control enrolls the rig once its pod runs.

```sh
thermite runpod launch runpod --gpu "RTX A4000" --spend-limit 20 --idle-stop 60 \
  --control https://control.example.com --token-file ~/.thermite/owner-token
```

It prints the rig on one line, then `Launched: RunPod bills the pod from now. Control enrolls it once it runs; follow it with thermite runpod list.`

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--gpu G` | Yes | | A GPU type's id or name in RunPod's list |
| `--gpus N` | No | `1` | GPUs in the pod: 1 to 8 |
| `--cloud-type SECURE` | No | `SECURE` | Secure cloud on demand. Control refuses `COMMUNITY` until a later version |
| `--datacenter DC` | No | any | A data center's id |
| `--image I` | No | control's `THERMITE_RUNPOD_RIG_IMAGE` | The one-container rig image |
| `--disk GB` | No | `40` | The container's own disk |
| `--volume GB` | No | `100` | The pod's volume at `/workspace`, which keeps the rig's state |
| `--rig NAME` | No | `rp-` and 8 hexadecimal characters | The rig's name |
| `--enroll-within MIN` | No | no expiry | The enrollment code expires this many minutes after the launch |
| `--setting NAME=VALUE` | No | a GPU rig on all the pod's GPUs | One of the rig's settings at enrollment; give it again for each |
| `--spend-limit USD` | No | none | Control stops the pod once it has cost this much |
| `--idle-stop MIN` | No | none | Control stops the pod once no run has run on the rig for this many minutes |
| `--control URL`, `--token-file F` | Yes | | Control's address, and a file with the owner's token |

[Rigs on a GPU cloud](rest-api.md#rigs-on-a-gpu-cloud) gives each field's limits and every refusal. An option with a value it can't take ends the command with exit code 2 and a reason, such as `--gpus takes a whole number, not "two"` or `--cloud-type is SECURE or COMMUNITY, not "spot"`.

### `runpod list`

`thermite runpod list --control URL --token-file F` lists the rigs launched on GPU clouds, from `GET /v1/rigs`. With `CLOUD`, only that cloud's (`GET /v1/gpu-clouds/CLOUD/rigs`). `--json` prints control's answer instead.

```text
rp-1a2b3c4d · pod pod1 · RUNNING · 1 × RTX A4000 (Secure) · $0.25/h · spent $1.50 · spend limit $20.00 · no idle stop · enrolled
```

Each line has the rig, its pod, the pod's status at RunPod (`gone` once RunPod no longer has it), its GPUs and cloud, its price per hour, what it has cost so far, its limits and its enrollment. Indented lines under it say `stopped by control: spend limit` (or `idle stop`) when control stopped the pod at a limit, or `stopped by the owner`; `under way:` and the stop, start, restart or terminate under way, such as `under way: stopping: waiting for its results to leave the pod`; and `last error:` with what control's last read of the pod found, or why a terminate was refused. With no rig it prints `no rig on a GPU cloud`.

### `runpod limits`

`thermite runpod limits RIG --spend-limit USD --idle-stop MIN` sets a rig's limits (`POST /v1/rigs/RIG/runpod/limits`), and prints the rig's line. `off` clears a limit, and a limit left out stays: `--spend-limit off` removes the spend limit and keeps the idle stop. Without either option it ends with `give --spend-limit, --idle-stop or both (a number, or off)`. Only the owner's token may change them.

### `runpod stop`, `start`, `restart`, `terminate`

These change a RunPod rig's pod, with the owner's token. Each prints the rig's line, as `runpod list` does, then what happens next.

```sh
thermite runpod stop rp-1a2b3c4d --control https://control.example.com --token-file ~/.thermite/owner-token
```

| Command | Route | What it prints after the rig's line |
| --- | --- | --- |
| `thermite runpod stop RIG` | `POST /v1/rigs/RIG/runpod/stop` | `Stopping: its runs are paused and its results go out first, then the pod stops. Follow it with thermite runpod list.` |
| `thermite runpod start RIG` | `POST /v1/rigs/RIG/runpod/start` | `Started: RunPod bills the pod from now. The runs the last stop paused resume once it runs.` |
| `thermite runpod restart RIG` | `POST /v1/rigs/RIG/restart`, then `GET /v1/rigs/RIG/runpod` | `Restarting: the pod stops, then starts again. Its volume stays.` |
| `thermite runpod terminate RIG` | `POST /v1/rigs/RIG/runpod/terminate` | `Terminating: its runs are paused, and the pod is removed only once every result has left it. Follow it with thermite runpod list.` |

Naming the rig in `terminate` is the confirmation: the command sends `{"confirm":"terminate RIG"}`. A refusal, such as `RunPod has no free GPU for pod … now, so the pod stays stopped (…)`, ends the command with exit code 2, as in [Refusals](#rules-for-every-command). [Stop, start, restart and terminate](rest-api.md#stop-start-restart-and-terminate) lists each refusal and how each change goes.

### `runpod reset`, `confirm-wipe`, `cancel-reset`

A full reset of a RunPod rig, with the owner's token: every result leaves the pod, the rig's state is wiped after your confirmation, and the pod and its GPU stay. Each first reads `GET /v1/rigs/RIG/runpod`, so a rig not on RunPod gets 404 and nothing starts.

| Command | Route | What it prints |
| --- | --- | --- |
| `thermite runpod reset RIG` | `POST /v1/rigs/RIG/reset` with `{"confirm":"reset RIG"}` | `Full reset <id> of RIG started: its runs are paused, and every result leaves the pod. Check the export, then confirm the wipe with thermite runpod confirm-wipe RIG.` |
| `thermite runpod confirm-wipe RIG` | `POST /v1/resets/<id>/confirm`, for the rig's reset that has not ended (`GET /v1/resets`) | `The wipe of reset <id> is confirmed: RIG's state is wiped, and the pod and its GPU stay.` |
| `thermite runpod cancel-reset RIG` | `POST /v1/resets/<id>/cancel`, likewise | `Reset <id> is cancelled: nothing was wiped, and RIG's runs stay paused.` |

With no reset of the rig under way, `confirm-wipe` and `cancel-reset` end with `no full reset of RIG is under way` and exit code 2. [Restart and full reset](rest-api.md#restart-and-full-reset) gives a reset's states.

### `command`

`thermite command` sends any [signed command](signed-commands.md) through control (`POST /v1/commands`) and prints control's answer on one line, such as `{"id":"<command id>","status":"pending"}`.

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |
| `--rig U` | Yes | | The rig |
| `--kind K` | Yes | | The command's kind, such as `pause_run`, `rig_check` or `queue_add` |
| `--payload JSON\|@file` | Yes | | The payload as JSON, or `@` and a file that holds it |
| `--ttl MIN` | No | `60` | Minutes before it expires: 1 to 10080 |

It takes every kind but `wipe_state`, the owner's commands for a run's experiment queue among them. For example, this adds an experiment at the top of `run-1`'s queue (without `position`, it goes to the end):

```sh
npx thermite command --control https://control.example.com --token-file ~/thermite-owner-token \
  --rig rig-1 --kind queue_add \
  --payload '{"run":"run-1","title":"unroll the inner loop by 4","why":"the profile shows loop overhead","position":"top"}'
```

Control refuses `wipe_state` with `400 {"error":"wipe_state is issued only by a full reset"}`, and a payload that does not fit its kind with `400 {"error":"bad <kind> payload: …"}` (an unknown rig: `404`). `GET /v1/commands/<id>` and the dashboard's **Commands** page show the command's status. A command the rig refuses, such as a `queue_move` for an experiment that is no longer queued, shows there as `failed`, with the reason.

### `submit`

`thermite submit` sends a change to a harness as a proposer (`POST /v1/attempts`), the way a person or a script tests a kit by hand. See [Test a kit with known candidates](../how-to/campaigns/test-a-kit.md).

| Option | Required | Meaning |
| --- | --- | --- |
| `--harness URL` | Yes | The harness's API, such as `http://127.0.0.1:8700` inside the harness container |
| `--token-file F` | Yes | A file with the harness's proposer token (`THERMITE_PROPOSER_TOKEN_FILE` on the harness; `/run/secrets/harness-proposer-token` under compose). Without a proposer token on the harness, every submission is refused |
| `--run ID` | Yes | The run |
| `--patch-file P` | Yes | A patch from `git diff --binary` against the run's champion |
| `--hypothesis TEXT` | Yes | What the change does and why it should help: 1 to 4000 characters |
| `--known-flaw TEXT` | No, repeatable | A flaw you know of, 1 to 1000 characters each, at most 50 |

It prints the harness's answer on one line: `{"attempt":"<id>","lifecycle":"queued","commit":"<commit>","violations":[]}`. `lifecycle` is `queued`, `rejected_v0` (the change broke a rule before judging, listed in `violations`) or `duplicate` (with `duplicate_of`). The [verdicts reference](verdicts.md) lists the states.

### `status`

`thermite status --harness URL --token-file F --attempt ID` prints what the harness knows of an attempt (`GET /v1/attempts/ID`): `attempt`, `run`, `lifecycle`, `commit`, `v0` and `verdict`. The token is the proposer's or the supervisor's.

It prints the harness's answer whatever its HTTP status, and exits 0 even when the harness answers with an error such as `no attempt <id>`.

### `local init`

`thermite local init DIR` makes `DIR`, the `.dev` folder that the local compose stack reads, and keeps every file that is there already. A release's compose file runs it in its `init` service as `thermite local init /work/.dev`, with the folder of `compose.yaml` mounted at `/work`. In a checkout of the source code, `npm run dev:init` makes the same folder without a build. It needs no network.

| What | Mode | Made |
| --- | --- | --- |
| `secrets/`, `outbox/`, `advisors/` | 0755 | When missing |
| `inbox/`, `inbox/repos/`, `inbox/models/` | 0777, set again at every run | When missing. The supervisor writes into the inbox as its own user |
| `secrets/control-admin-token`, `control-operator-token`, `control-rig-token`, `control-rig-token-2`, `harness-supervisor-token`, `harness-proposer-token`, `harness2-supervisor-token`, `harness2-proposer-token` | 0644 | When missing: 24 random bytes each, base64url-encoded |
| `secrets/model-api-key` | 0644 | When missing: `local-placeholder` |
| `secrets/control-rig-tokens.json` | 0644 | At every run, from the two rig tokens: `{"local-1": …, "local-2": …}` |

Run as root, when the folder that holds `DIR` belongs to another user, it gives what it makes to that user and group, and says so. It prints `made` and the path of each folder and file it made, never a token, then `local init: <name> ready (<n> made, <m> kept)`, where `<name>` is the last part of `DIR`. Without `DIR`, it prints the usage text on standard error and exits 2.

### `selftest isolation`

`thermite selftest isolation [--force]` runs the isolation check inside the harness container, as root: it checks that each role's user is refused the ledger, the kits, the builds, the secrets and anything else it must not reach. It prints the report as indented JSON (`ok`, `devices`, `roles`, `skipped`) and exits 1 if `ok` is false.

| Option | Meaning |
| --- | --- |
| `--force` | Probe even while trials or judge jobs are open. Each probe ends every process of the role it tests, so those trials and jobs end too |

Without `--force`, a busy rig is refused, with exit 2: `the rig is busy: <n> open trial(s) and <m> judge job(s): pause the rig's runs and let the judge finish first (each probe kills its role's processes); rerun with --force to probe anyway`.

It reads where the broker's socket and the rig's directories are from `THERMITE_BROKER_DIR` (default `/run/thermite`), `THERMITE_STATE_DIR` (`/var/lib/thermite`), `THERMITE_SCRATCH_DIR` (`/scratch`) and `THERMITE_OUTBOX_DIR` (`/outbox`), and probes the secret files named by `THERMITE_SUPERVISOR_TOKEN_FILE`, `THERMITE_PROPOSER_TOKEN_FILE` and `THERMITE_MODEL_API_KEY_FILE`. The same check runs from the dashboard as a rig check; see [Rig checks](rig-checks.md) and [Check a rig](../how-to/operate/check-a-rig.md).

## `thermite-trial`

`thermite-trial` is in the harness image only (`/usr/local/bin/thermite-trial`, which runs `node /opt/thermite/dist/harness/agents/trial-cli.js`). A worker agent that works through its own shell, under OpenCode or Claude Code, uses it to submit its change, run a command on the device, read an attempt, propose an idea for the run's [experiment queue](signed-commands.md#queue_add), keep [field notes](knowledge-base.md#field-notes), and record the sources it reads with five of its `research` commands. A research worker under OpenCode uses all its `research` commands, and may propose ideas and keep field notes too. It runs as the [lane](glossary.md)'s user, in the trial's workspace (a research trial's: its lane's working area), with the trial's own token, which stops working when the trial ends.

```text
usage:
  thermite-trial submit --hypothesis TEXT [--claim TEXT] [--flaw TEXT]...
  thermite-trial dev-run [--timeout SECONDS] -- COMMAND...
  thermite-trial status ATTEMPT
  thermite-trial idea TITLE [--why TEXT] [--family TEXT] [--details TEXT]
  thermite-trial note --kind KIND [--about TYPE:ID] TEXT
    KIND: observation, decision, surprise, question, lesson or note
    TYPE: experiment, attempt, source, claim, finding, round, trial or message
  thermite-trial research TOOL ... (thermite-trial research help lists them)
```

| Command | What it does | Prints |
| --- | --- | --- |
| `submit --hypothesis TEXT [--claim TEXT] [--flaw TEXT]...` | Stages and diffs only the trial's editable paths, then submits the change. The hypothesis and the claim are cut to 2000 characters, each flaw to 1000. Submitting ends the trial | `submitted <attempt>: <lifecycle>. The trial ends with this submission.`, with `; refused: <violations>` before the last sentence when the change broke a rule |
| `dev-run [--timeout SECONDS] -- COMMAND...` | Runs the command on the measurement device, as a [development run](glossary.md), in the trial's workspace | The run's result as indented JSON |
| `status ATTEMPT` | Shows one of this lane's attempts | The attempt as indented JSON |
| `idea TITLE [--why TEXT] [--family TEXT] [--details TEXT]` | Proposes another experiment for the run's queue, as the lane's idea: something worth trying that is not the trial's own work. The words after `idea` are its title, cut to 200 characters; `--why` is cut to 2000, `--family` (its direction) to 80 and `--details` to 4000. A repeated option keeps its last value. A title that is one word naming a command (`submit`, `dev-run`, `status`, `idea`, `note`, `research`, `list`, `ls`, `show`, `help`, `-h`, `--help`) is refused, so a slip does not become an idea; a longer title that starts with one is fine. The idea waits until the planner or the campaign's owner queues it or drops it, and the trial goes on. Without the planner's model (none set, its answer refused, the planner off, or a research run), it waits for the owner. No limit is set on how many | `proposed <experiment id>: it waits until the planner or the campaign's owner queues it or drops it. Your trial goes on.` |
| `note --kind KIND [--about TYPE:ID] TEXT` | Writes a [field note](knowledge-base.md#field-notes) for the run's journal: an observation, a decision and why, a surprise, a question or a lesson. The words after the options are its text, 1 to 2000 characters. `--kind` is one of the kinds in the usage text, in any case. `--about` names one record of the run it is about, such as `attempt:a-11110003` or `round:12`; a round or a message is named by its number. A repeated option keeps its last value. The note is recorded as the lane's, and the trial goes on. No limit is set on how many | `noted (#<id>). Your trial goes on.` |
| `research TOOL [WORDS...] [--FLAG VALUE]... [-]` | Runs one of a research trial's tools (below) through the harness's research service. The words fill the tool's main field and the flags its others; `-` reads a JSON object of fields from standard input | The tool's answer: text as it is, anything else as JSON, cut at 14,000 characters |
| `research help` | Lists the research tools | `research tools:` and each tool's use |

The research tools are a Pi research worker's, without its file tools. In a hill-climb or goal trial only five of them work: `fetch`, `read_source`, `search_corpus`, `add_claim` and `add_note`. They archive the pages a worker reads and record what they say in the run's research folder. The harness refuses the others there: `a hill-climb run records sources, claims and notes only (fetch, read_source, search_corpus, add_claim, add_note); the rest belongs to research runs` (`a goal run` in a goal campaign). `research help` lists all ten.

| Tool | Words | Flags | What it does |
| --- | --- | --- | --- |
| `fetch` | `URL` | | Fetches a web page; the harness archives it and returns its text and links |
| `read_source` | `SOURCE` | `--offset N`, `--length N` | Reads more of an archived source's text, from an offset |
| `search` | `QUERY` | | Searches the web. Rigs have no web search yet, so it returns the reason |
| `search_corpus` | `TEXT` | | Searches the archived sources for a piece of text, ignoring case |
| `add_claim` | none | `--text`, `--question N`, `--confidence N`; the quotes only through `-` | Records a claim with exact quotes from archived sources. Unverified quotes leave it a draft. `question` is the index of the campaign question it answers, from 0 |
| `add_note` | `TEXT` | `--source SOURCE`, repeated | Records a research note, with the sources it relies on: its text cut to 4000 characters, at most 20 sources. An empty text is refused: `a note needs its text`. A research note is not a field note |
| `propose_hypothesis` | `TEXT` | `--supporting CLAIM`, repeated | Proposes a hypothesis, citing the verified claims that support it |
| `add_finding` | none | none: every field through `-` | Records a finding: `text`, `summary`, `why_it_matters` and the `supporting` claims. Draft claims, or numbers not in those claims, leave it a draft |
| `update_section` | none | `--name`, `--body` | Writes or replaces a section of the campaign report |
| `progress` | none | | Shows the corpus, claims, question coverage and time remaining |

A claim's quotes go through standard input, in a quoted heredoc so the shell changes nothing inside them:

```sh
thermite-trial research add_claim - <<'EOF'
{"text": "the claim", "quotes": [{"source": "SOURCE", "quote": "exact words from it"}], "question": 0, "confidence": 0.8}
EOF
```

It reads these settings, which the harness sets for each trial:

| Setting | Default | Meaning |
| --- | --- | --- |
| `THERMITE_HARNESS_URL` | `http://127.0.0.1:8700` | The harness's API |
| `THERMITE_TRIAL_AUTH` | none | The trial's token, as `trial.<token>` |
| `THERMITE_WORKSPACE` | The current directory | The trial's workspace |
| `THERMITE_EDITABLE_PATHS` | `[]` | The paths the trial may change, as a JSON list of globs |

Everything it prints goes to standard output.

| Message | Exit |
| --- | --- |
| `error: submit needs --hypothesis` | `2` |
| `error: there are no changes inside the editable paths (<paths>)` | `2` |
| `error: dev-run needs a command after --` | `2` |
| `error: status needs an attempt id` | `2` |
| `error: idea needs a title: what to try, in a few words` and the usage text | `2` |
| `error: "<title>" is a command word, not an idea. idea proposes an experiment: give what to try, in a few words. thermite-trial does not list the run's ideas or queue.` and the usage text, for a one-word title that names a command | `2` |
| `error: idea has no --<option>` and the usage text | `2` |
| `error: note needs --kind: observation, decision, surprise, question, lesson or note` and the usage text | `2` |
| `error: note needs its text: what you observed, decided or learned` and the usage text | `2` |
| `error: --about takes TYPE:ID, for example experiment:x-0123456789ab` and the usage text | `2` |
| `error: note has no --<option>` and the usage text | `2` |
| `error: no research tool "<name>"` and the list of tools | `2` |
| `error: <tool> takes no words; use:`, `error: <tool> has no --<flag>; use:` or `error: "-" reads a JSON object from stdin…`, with the tool's use | `2` |
| `error: --<flag> needs a number` | `2` |
| The usage text, for an unknown command | `2` |
| `error: <status>: <body>`, when the harness refuses the call, such as `error: 400: {"error":"about: no attempt a-… in run <run>"}` for a note about a record the run does not have | `1` |

## Programs inside the images

Each image starts one program under `tini`; none of them takes options.

| Image | Starts | As |
| --- | --- | --- |
| Control | `node /opt/thermite/dist/control/main.js` | User `thermite` (10001) |
| Supervisor | `node /opt/thermite/dist/supervisor/main.js` | User `supervisor` (10001) |
| Harness | `node /opt/thermite/dist/harness/broker.js`. The broker runs as root and starts the harness's other processes, each as its own user | root |

Their settings are environment variables: see [Settings](settings.md). The [harness image reference](harness-image.md) lists what else the harness image holds.
