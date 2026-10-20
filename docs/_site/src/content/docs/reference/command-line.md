---
title: "Command line"
description: "Every thermite command and option, where it runs, what it prints and its exit codes, and thermite-trial inside the harness image."
type: reference
sidebar:
  order: 5
---

`thermite` is Thermite's command line. It checks contracts, makes tokens, starts runs and sends [signed commands](signed-commands.md) through control, enrolls rigs, and talks to a rig's harness. The harness image also holds `thermite-trial`, the command a worker agent uses from its own shell.

```sh
npx thermite contract validate contract.json
npx thermite command --control https://control.example.com --token-file ~/thermite-owner-token \
  --rig rig-1 --kind pause_run --payload '{"run":"run-1","reason":"checking the kit"}'
```

The first prints `ok`, the contract's mode, name, version and SHA-256. The second prints the new command's id and `"status":"pending"`. For the steps around these commands, see [Start a campaign from the command line](../how-to/campaigns/start-from-command-line.md) and [Make and change tokens](../how-to/operate/tokens.md). The words [control](glossary.md), [rig](glossary.md), [harness](glossary.md) and [run](glossary.md) are in the glossary.

## Where it runs

| Where | How to run it | Used there for |
| --- | --- | --- |
| Your computer, in a clone of the repository | `npx thermite <command>`, after `npm ci` and `npm run build`. It runs `dist/cli/thermite.js` and needs Node.js 22.19 or later | Contracts, tokens, starting runs, commands, enrolling rigs |
| Control's image | `thermite` (`/usr/local/bin/thermite`, which runs `node /opt/thermite/dist/cli/thermite.js`) | The same commands, from inside control's container |
| The supervisor's image | `thermite`, the same wrapper | The same commands |
| The harness image | `thermite`, the same wrapper, and `thermite-trial` | `submit` and `status` against the harness at `http://127.0.0.1:8700`; `selftest isolation`, which must run there, as root |

Under the local compose stack the harness publishes no port, so `submit`, `status` and `selftest isolation` run inside the harness container, for example with `docker compose exec harness thermite selftest isolation`.

## Usage

`thermite`, `thermite help` and `thermite --help` print this text and exit 0:

```text
usage: thermite <command> [options]

  contract validate <file>            validate a contract and print its sha256
  keys generate <dir>                 write a new Ed25519 control signing key pair
  token new --out F                   make a control token: write it to F (mode 0600; keep it,
                                      for example in a password manager) and print its SHA-256,
                                      the only part control's deployment needs
  assign --contract F --run ID [--seed GIT_URL[@COMMIT] | --seed-commit C] [--kit GIT_URL]
         [--model NAME=URL ...] [--direction D] [--agents off] [--promotion auto|owner]
         (--control URL --token-file F --rig R [--ttl MIN] | --print)
                                      start a run. The rig's supervisor fetches the project and
                                      kit commits from their repositories, and models from their
                                      URLs, before the harness checks them. --seed-commit names a
                                      commit already on the rig (an earlier run's result); a kit
                                      already there needs no --kit. --print shows the payload
                                      (for issue_command over MCP) instead of issuing it
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
  command --control URL --token-file F --rig U --kind K --payload JSON|@file [--ttl MIN]
                                      issue a signed command through control (admin token)
  submit --harness URL --token-file F --run ID --patch-file P --hypothesis TEXT
         [--known-flaw TEXT ...]      submit a patch as a proposer
  status --harness URL --token-file F --attempt ID
                                      show an attempt's lifecycle and verdict
  selftest isolation [--force]        inside the harness container, as root, with the rig idle: check that role
                                      users cannot reach the ledger, kits, builds or secrets
```

## Rules for every command

- **Options.** Each option takes its value as the next word or after `=`. In `token new`, `assign`, `assign-payload`, `rig`, `command`, `submit` and `status`, an option the command does not know, or a word it does not expect, ends the command with Node's own message and exit code 2.
- **Older option names.** `--instance` is read as `--run`, and `--unit` as `--rig`. These are the names from before runs and rigs were renamed.
- **Control's token.** The commands that talk to control (`assign`, `command`, `rig add`, `rig token`, `rig retire`) send the contents of `--token-file`, trimmed, as `Authorization: Bearer <token>`. Only the owner's token works on these routes; any other token gets `401 {"error":"unauthorized"}`. See [Tokens and roles](tokens.md).
- **Control's address.** `--control` is control's base address, such as `https://control.example.com`. A trailing `/` is removed.
- **Refusals.** When control or the harness refuses a request, the command prints `<url> -> <status> <body>` on standard error and exits 2. `status` is the exception: see [below](#status). A request body that does not match the route gives `400 {"error":"invalid request"}`; a refusal from inside control (for example an unknown rig or a payload that does not fit its kind) gives `500` with the reason. The [REST API reference](rest-api.md) lists the routes.

### Exit codes

| Code | When |
| --- | --- |
| `0` | The command did its work. Also `thermite`, `help` and `--help` |
| `1` | `contract validate` found the contract invalid; `selftest isolation` found a probe that was not refused |
| `2` | Missing or wrong options (the usage text goes to standard error); an unknown command (the usage text goes to standard output); a refused request; any other error, with its message on standard error |

## Commands

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
| `--control URL` | To send it | | Control's address |
| `--token-file F` | To send it | | A file with the owner's token |
| `--rig R` | To send it | | The rig that runs it |
| `--ttl MIN` | No | `60` | Minutes before the command expires if the rig has not taken it: a whole number from 1 to 10080 (7 days) |
| `--print` | Instead of the four above | | Print the payload as indented JSON and send nothing. The output is what the MCP tool `issue_command` takes as `payload` |

`--seed` and `--seed-commit` together are refused. For a research contract, the run has no seed and no kit, and `--seed`, `--seed-commit` and `--kit` are not used.

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

Control refuses `wipe_state` with `400 {"error":"wipe_state is issued only by a full reset"}`, and a payload that does not fit its kind with `500 {"error":"bad <kind> payload: …"}`. `GET /v1/commands/<id>` and the dashboard's **Commands** page show the command's status. A command the rig refuses, such as a `queue_move` for an experiment that is no longer queued, shows there as `failed`, with the reason.

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

### `selftest isolation`

`thermite selftest isolation [--force]` runs the isolation check inside the harness container, as root: it checks that each role's user is refused the ledger, the kits, the builds, the secrets and anything else it must not reach. It prints the report as indented JSON (`ok`, `devices`, `roles`, `skipped`) and exits 1 if `ok` is false.

| Option | Meaning |
| --- | --- |
| `--force` | Probe even while trials or judge jobs are open. Each probe ends every process of the role it tests, so those trials and jobs end too |

Without `--force`, a busy rig is refused, with exit 2: `the rig is busy: <n> open trial(s) and <m> judge job(s): pause the rig's runs and let the judge finish first (each probe kills its role's processes); rerun with --force to probe anyway`.

It reads where the broker's socket and the rig's directories are from `THERMITE_BROKER_DIR` (default `/run/thermite`), `THERMITE_STATE_DIR` (`/var/lib/thermite`), `THERMITE_SCRATCH_DIR` (`/scratch`) and `THERMITE_OUTBOX_DIR` (`/outbox`), and probes the secret files named by `THERMITE_SUPERVISOR_TOKEN_FILE`, `THERMITE_PROPOSER_TOKEN_FILE`, `THERMITE_MODEL_API_KEY_FILE` and `QWEN_API_KEY_FILE`. The same check runs from the dashboard as a rig check; see [Rig checks](rig-checks.md) and [Check a rig](../how-to/operate/check-a-rig.md).

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
