---
title: "Set up the results repository"
description: "Give a rig a git repository where its supervisor pushes every attempt, champion and event."
type: how-to
sidebar:
  order: 3
---

Every hour in which something new happened, a rig's harness (its container that holds the judge and the agents) writes an **export**: the new attempts, champions and events since the last one. The rig's supervisor (its other container, the link to the outside) commits each export to git and pushes it to the **results repository**. That repository is the lasting copy of a rig's work. A [full reset](rig-lifecycle.md#fully-reset-a-rig) needs it, and so does [sending a champion to another rig](../campaigns/several-rigs.md).

This page sets up a results repository on your own git host, reached over SSH.

## Which rigs have one

- **The local compose stack** has one already. Both of its rigs push to `file:///results/results.git`, a repository on a volume they share. Nothing reaches the outside world. This page moves it to your git host.
- **Rigs that control sets up on a machine or a cluster, and rigs you join yourself, have no results repository yet**: control can't give them one ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). Their exports are committed only inside the supervisor's volume, and the **Results** row on their page says `no results repository`. So they have no lasting copy of their results outside the rig, no full reset, and no champions sent to or from other rigs.

So the steps below are for the compose stack. `thermite rig add` writes the files for a rig you deploy your own way, but Thermite ships no deployment that reads them ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).

## Before you start

- An empty repository on your git host, for example `ssh://git@git.example.com/lab/thermite-results.git`.
- OpenSSH's `ssh-keygen` and `ssh-keyscan` on your computer.

## 1. Make a deploy key

Make a folder that only you can open, and an SSH key pair in it without a passphrase (the supervisor has no one to type it):

```sh
mkdir -m 700 .dev/results-ssh
ssh-keygen -t ed25519 -N "" -C thermite-results -f .dev/results-ssh/deploy-key
```

On your git host, add `.dev/results-ssh/deploy-key.pub` to the repository as a deploy key **with write access**. The supervisor pushes with it.

## 2. Pin the host's key

Save the git host's public key, then compare its fingerprint with the one your git host publishes:

```sh
ssh-keyscan -t ed25519 git.example.com > .dev/results-ssh/known-hosts
ssh-keygen -lf .dev/results-ssh/known-hosts
```

With this file, the supervisor talks only to a host that shows this key.

## 3. Give the supervisor the three settings

| Setting | What it holds |
| --- | --- |
| `THERMITE_RESULTS_REMOTE` | The repository's URL |
| `THERMITE_RESULTS_KEY_FILE` | The path of the deploy key's private half, inside the supervisor's container |
| `THERMITE_RESULTS_KNOWN_HOSTS` | The path of the known hosts file, inside the supervisor's container |

`compose.yaml` passes on only the first one, so add an override file next to it. It adds the two files to the supervisor as secrets, on top of the ones `compose.yaml` gives it:

```yaml title="compose.results.yaml"
services:
  supervisor:
    environment:
      THERMITE_RESULTS_REMOTE: ssh://git@git.example.com/lab/thermite-results.git
      THERMITE_RESULTS_KEY_FILE: /run/secrets/results-deploy-key
      THERMITE_RESULTS_KNOWN_HOSTS: /run/secrets/results-known-hosts
    secrets: [results-deploy-key, results-known-hosts]
secrets:
  results-deploy-key: { file: ./.dev/results-ssh/deploy-key }
  results-known-hosts: { file: ./.dev/results-ssh/known-hosts }
```

The supervisor runs as its own user inside its container, so it can't read a key file that only you may read. What keeps the key from other users of this computer is the folder: it stays yours alone (mode 700). Compose mounts the file itself into the container, so the folder's mode doesn't stop the supervisor. Make the key file readable, then start the stack with both files:

```sh
chmod 644 .dev/results-ssh/deploy-key
docker compose -f compose.yaml -f compose.results.yaml up -d   # or: podman compose …
```

On a Mac with Podman, skip the `chmod`: the supervisor can read the key at mode 600 there, and ssh refuses a key that others may read. With mode 644, the pushes fail with `push failed: Command failed: git … push …` and `@@@@@@@@@`, the start of ssh's `UNPROTECTED PRIVATE KEY FILE` warning. To fix it, run `chmod 600 .dev/results-ssh/deploy-key`, then `podman compose -f compose.yaml -f compose.results.yaml up -d --force-recreate supervisor`.

From now on, name every override file you use, each with its own `-f`, on every `up`, such as `-f compose.yaml -f compose.tokens.yaml -f compose.results.yaml`. A file left out drops its settings. [Install Thermite on one machine](../install/one-machine.md#settings-and-override-files) lists every override file and gives the full command. For the second rig of the `two-rigs` profile, add the same lines for `supervisor-2`. Rigs can share one repository: each rig pushes only its own branches.

:::note[Without the key file]
`THERMITE_RESULTS_KNOWN_HOSTS` works only together with `THERMITE_RESULTS_KEY_FILE`. With the key file but no known hosts file, the supervisor trusts the first key the host shows and keeps it in its volume. With no key file, git uses plain SSH defaults, and a host it doesn't know fails. There is no setting for an HTTPS token.
:::

The deploy key has a second use: the supervisor also fetches a campaign's project or kit over SSH with it, and with the known hosts file, when their source names no [Git access](../campaigns/private-repository.md). If you add this key to a project's or kit's repository for that, give it read access only there. For private repositories, a Git access is the usual way.

## 4. See that pushes work

Open the rig's page (**Rigs** in the sidebar, then the rig) and press **Export now** to export at once, rather than wait for the hour. Then, after a minute or two, press **refresh** in the status bar, the line along the bottom of the page:

- The **Results** row of the **The rig** block says `N exports · pushed … ago`.
- On your git host, the repository has two branches for the rig. If you can reach the repository from your computer, list them:

  ```sh
  git ls-remote ssh://git@git.example.com/lab/thermite-results.git
  ```

  ```text
  <commit>	refs/heads/thermite/local-1/attempts
  <commit>	refs/heads/thermite/local-1/ledger
  ```

If a push fails, the **Results** row shows `push failed:` and git's message in red, and **Rigs** says `Its last export failed: …`. The supervisor tries again every minute until a push works, so fix the cause (the deploy key's write access, the host key) and wait. The supervisor logs an `exported` line whenever it commits exports or its error changes, with the error if there is one:

```sh
docker compose logs supervisor | grep exported
```

## What gets pushed

Each rig has two branches. Commits are made by `thermite <thermite@localhost>`.

| Branch | Path | What it holds |
| --- | --- | --- |
| `thermite/<rig>/attempts` | `attempts/<attempt>.patch` and `.json` | Each attempt's change, and its record with the verdict |
| | `champions/<run>/<seq>.patch` and `.json` | Each published champion, as a patch from the run's starting commit |
| | `events/<export>.jsonl` | The export's events, one per line. They include the text of your messages to the run's agents and advisors, and the advisors' answers |
| | `exports/<export>.json` | The export's manifest: each file with its SHA-256 |
| | `research/<run>/…` | Only from a full export (a full reset takes one): a research run's archive, and in `research/<run>/folder/` the [research folder](../../explanation/campaign-modes.md#research) of a run whose final report that export holds |
| `thermite/<rig>/ledger` | `ledger.sqlite`, `manifest.json` | A copy of the rig's ledger, at most once a day, and with every full export. Held-out results are left out, so they never leave the rig |

The attempts branch only grows: a file already published there is never replaced. The supervisor commits only files that the export's manifest lists, with the SHA-256 it lists. An export that fails that check is never pushed, and the **Results** row says `export … refused: …`.

How often the harness exports is its setting `THERMITE_EXPORT_MINUTES` (60 by default), and the **Exports** switch on **Edit rig** turns hourly exports off. **Export now** works either way.
