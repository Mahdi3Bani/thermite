---
title: "Troubleshoot"
description: "Find out why a check failed, a port clashes, a build is slow, a rig is quiet or a sign-in bounces back, and where the logs are."
type: how-to
sidebar:
  order: 8
---

Find the problem you see, then follow what to do. A [rig](../../reference/glossary.md) is two containers: the harness, which holds the judge and the agents, and the supervisor, its link to control. Most problems leave a line in a log, so [Where the logs are](#where-the-logs-are) comes first. Most commands below are for the local compose stack; with Podman, write `podman compose` where they say `docker compose`. For a rig on a machine or a cluster, the table below gives the commands that read its logs, and the entries say what to read there.

## Where the logs are

Every part of Thermite writes one JSON object per line, such as `{"at":"…","component":"supervisor","msg":"relay error","error":"…"}`.

| What | Where |
| --- | --- |
| Control, the harness and the supervisor of the local stack | `docker compose logs control`, `docker compose logs harness`, `docker compose logs supervisor`. Add `-f` after `logs` to follow them |
| A rig on a machine, set up by control or joined | On the machine, logged in over SSH as the user the rig runs as (not with `sudo -u`): `journalctl --user -u thermite-rig-1-supervisor.service`, and the same for `thermite-rig-1-harness.service`. For a rig that runs as root: `sudo journalctl -u thermite-rig-1-supervisor.service` |
| A rig on a cluster, set up by control or joined | `kubectl logs -n <namespace> deployment/thermite-rig-1-supervisor` (or `-harness`) |
| What a rig did | The rig's page: **Recent** for its history, **Checks** for its checks, and the **Set up by control** or **You run it yourself** block for each setup step |
| What control did, refused or failed at | **Audit log** in the sidebar (the newest 300 entries), `GET /v1/audit`, or the MCP tool `control_log`. Dashboard refusals are entries named `refused`, and requests that ended in an error are named `failed`, each with the reason (for a refusal shown as a plain page, such as `bad form token`, only its HTTP status) |
| Where each command went | **Commands** in the sidebar: each command's status (`pending`, `delivered`, `rejected`, `failed`, `expired`) and the rig's answer in **Outcome** |

There is no single Logs page yet ([goal 027](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/027-logs-page.goal)).

## Compose won't start: a secret file is missing

- **You see:** `docker compose up` stops with an error about a file in `.dev/secrets/`.
- **Why:** the local tokens don't exist yet. `compose.yaml` reads them from `.dev/secrets/`.
- **Do:** run `npm run dev:init` in the repository's top folder, then start again.

## Control stops at start: `control needs the owner's credential`

- **You see:** control keeps restarting, and `docker compose logs control` has a `fatal` line that says `control needs the owner's credential`.
- **Why:** control has no owner's token. After you switch to an owner's token of your own, the token file is empty on purpose, and only the override file gives control the hash.
- **Do:** start the stack with both files: `docker compose -f compose.yaml -f compose.tokens.yaml up -d`. See [Use an owner's token of your own](../install/one-machine.md#use-an-owners-token-of-your-own).

## Control stops at start: `EPERM` on `control-signing.key`

- **You see:** control keeps restarting, and its log has a `fatal` line with `EPERM: operation not permitted, chmod '/var/lib/thermite-control/control-signing.key'`.
- **Why:** you added `compose.lifecycle.yaml` to a stack that had already run. See [Give control a deployment driver](rig-lifecycle.md#give-control-a-deployment-driver).
- **Do:** start the stack again without that file.

## The port is already in use

- **You see:** `docker compose up` fails because port 8800 is taken.
- **Why:** another program, or another Thermite stack, uses port 8800 on your computer.
- **Do:** choose another port: `THERMITE_CONTROL_PORT=8801 docker compose up -d`, or put `THERMITE_CONTROL_PORT=8801` in a `.env` file next to `compose.yaml`. The dashboard is then at `http://127.0.0.1:8801/ui`.

## The harness restarts at the first start

- **You see:** the harness's log has `timed out waiting for /keys/control-signing.pub`, and it starts again.
- **Why:** control writes its public key when it first starts, and the harness waits only two minutes for it.
- **Do:** nothing. The harness starts again by itself and finds the key.

## The first build is slow

- **You see:** `docker compose up -d --build` takes 20 minutes or more.
- **Why:** it builds three images from source, and the harness image installs compilers, Python and agent programs. A GPU image's base is a large download too.
- **Do:** wait for it once. Later, start without `--build` (`docker compose up -d`) to reuse the images, and rebuild only what changed, for example `docker compose build harness`.

## The Podman VM runs out of disk or memory

- **You see:** builds fail partway, or the VM's disk fills up. `podman system df` shows how much the images and volumes take.
- **Why:** on a Mac, Podman runs containers in a VM. Each build leaves old image layers behind, and each lane's compiler cache can grow to 8 GB.
- **Do:** free the space, then give it back to your Mac:

```sh
podman image prune -f              # remove untagged image layers only
podman machine ssh sudo fstrim -a  # give the freed space back to your Mac
```

Never prune tagged images: they may belong to other projects. For more memory or CPUs, stop the VM and change it with Podman's own command, `podman machine set --memory <MiB> --cpus <n>`.

## Sign-in comes back with no message

- **You see:** after **Sign in**, the sign-in page shows again.
- **Why:** the token is not the owner's. Only the owner's token signs in; an operator's, agent's or reader's token can't. A token with a space or a missing character fails too.
- **Do:** copy the owner's token again: `cat .dev/secrets/control-admin-token` on the local stack, or the file of the owner's token you made yourself. After 20 failures in a minute, the page says `too many failed sign-ins; wait a minute`.

A sign-in also ends when the owner's token changes, or after 30 days without use.

## A button answers `bad form token`

- **You see:** a plain page that says `bad form token` after you press a button.
- **Why:** the page was opened before your current sign-in, for example before you signed in again in another tab.
- **Do:** go back, reload the page and press the button again.

## A rig is quiet

- **You see:** the rig shows **Not reporting**, or never appears on **Rigs**.
- **Why and do:** read the supervisor's log. Most causes show in a `relay error` line:

| In the supervisor's log | Why | Do |
| --- | --- | --- |
| `waiting for the harness` and nothing more | The harness isn't up | Read the harness's log |
| `the rig's key waits for the owner's acceptance` or `rig key changed: the owner must accept the new key` | Control holds the rig's key | [Accept the rig's key](accept-a-rig-key.md) |
| `this rig is retired in control` | The rig was retired | Bring it back on its page: see [Retire and bring back](rig-lifecycle.md#retire-and-bring-back) |
| `ingest -> 401` with `unauthorized` | The supervisor's control token is wrong | Give it the rig's current token: see [Rig tokens](tokens.md#rig-tokens) |
| `the harness reports as rig …, but this supervisor is …` | The two containers have different `THERMITE_RIG_ID` settings | Make them the same |
| `report from the future` | The rig's clock is ahead of control's | Set the clocks right |
| No `relay error`, but the rig has never appeared | The supervisor has no control token file, so it reports nothing and logs no error | Check that the file its `THERMITE_CONTROL_TOKEN_FILE` names exists and holds the rig's token |

A rig control set up on a machine or a cluster may also still be pulling its images. Its setup steps say `no report after 10 minutes: it may not have started` when it took longer than that; it may still report later. For a rig on a cluster, see [A rig on a cluster never reports](#a-rig-on-a-cluster-never-reports).

## Pushes to the results repository fail with `@@@@@@@@@`

- **You see:** the **Results** row on the rig's page says `push failed: Command failed: git … push …` and `@@@@@@@@@`.
- **Why:** ssh refused the deploy key. On a Mac with Podman, it refuses a key file at mode 644.
- **Do:** see [Set up the results repository](results-repository.md#3-give-the-supervisor-the-three-settings).

## A rig on a cluster never reports

- **You see:** in the rig's **Set up by control** block, the step "First report reached control" has ✕ and `no report after 10 minutes: it may not have started`, and the block says `failed`.
- **Why:** its pods have not started, or its supervisor can't reach control. Often the nodes are still pulling the large images. A pod stays `Pending` when no node has room for what it asks, such as its GPUs, CPUs, memory or volume. It shows `ImagePullBackOff` when the nodes can't pull the images: a registry that needs a sign-in is not supported yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
- **Do:** look at the pods, in the namespace the block shows:

  ```sh
  kubectl get pods -n <namespace> -l app.kubernetes.io/instance=rig-1
  kubectl describe pods -n <namespace> -l app.kubernetes.io/instance=rig-1   # its Events say why it waits
  kubectl logs -n <namespace> deployment/thermite-rig-1-supervisor          # relay errors, as in the table above
  ```

  When the rig reports later, its page fills in, but the step keeps its ✕ ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).

## A join command stops at a check and then doesn't work

- **You see:** the join command stops with a line such as `thermite: Podman is missing: install Podman 4.4 or later, then make a new join command`. Run again, it fails with curl's `The requested URL returned error: 401`.
- **Why:** a join command works once. It is used up when the machine fetches its script, before the script checks the machine ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). The checks run before anything is written, so nothing was set up. In a namespace, a `kubectl apply` that fails uses the command up too.
- **Do:** fix what the message names. Then, on the rig's page, press **Make a new join command** and run the new one. After a failed check there is nothing to remove first, although the card asks you to. See [Join a rig yourself](../install/join-a-rig.md#4-make-a-new-one-or-revoke-it).

## A check failed

- **You see:** **Model route**, **Isolation** or **Judge smoke** shows **failed**.
- **Do:** read its sentence, and see [Check a rig](check-a-rig.md#read-the-result).

Two causes are common on a laptop:

- `not now: …`: the rig has open trials or judge jobs. Make it idle as [Check a rig](check-a-rig.md#before-you-start) says, then run the check again.
- **Judge smoke** fails with some candidates "judged otherwise", and the harness's log has `job failed` lines that say `target not ready for timing: load … above 75% of … cores`. The computer was too busy for fair timing. Close other heavy programs and run the check again.

## The isolation check failed

- **You see:** **Isolation** shows **failed**, with `isolation does NOT hold (devices: …):` and up to 12 items such as `agent-1 ledger: ALLOWED`.
- **Why:** each item is a role and a probe. `ALLOWED`: the role's user reached something it must not, such as the judge's files or a secret. `UNREADABLE`, `UNREACHABLE` or `WRONG GPUS`: a role was refused something it needs, or saw other GPUs than its own. `the device setup failed`: the rig's GPUs could not be split between the judge and the agents; the `devices:` part says why.
- **Do:**
  1. Pause the rig's runs, and start none on it until the check passes.
  2. Look up each probe in the [rig checks reference](../../reference/rig-checks.md#isolation-check). [Isolation inside a rig](../../explanation/isolation.md) explains what keeps each role apart.
  3. On an image you extended, compare with Thermite's own image ([Extend the harness image](../install/extend-harness-image.md)). For the device setup, check the rig's GPU settings ([Use several GPUs](../install/several-gpus.md)).
  4. Run the check again after each change. The harness also runs it every time it starts.

  If it still fails on Thermite's own image, ask for help with the whole sentence: see [Still stuck?](#still-stuck).

## A rig can't reach a model server on your network

- **You see:** **Model route** fails with `no answer in 120 s (is the model up?)`, or with `no tool call:` and a connection error, while the server answers on your computer.
- **Why:** the rig calls the model from its harness container. Inside a container, `localhost` is the container itself. A rig on a cluster reaches only DNS and addresses outside the private ranges, so a server on a private address is out of its reach.
- **Do:** on the local stack, use `host.docker.internal` in the provider's address (`host.containers.internal` with Podman). Give a rig on a cluster a hosted provider. See [Choose a model](../models/choose-a-model.md#2-a-model-server-on-your-own-computer).

## A campaign doesn't start: `staging:`

- **You see:** the run never appears. On **Commands**, in the sidebar, the **assign campaign** row is **failed**, and its **Outcome** holds `{"error":"staging: …"}`. The supervisor's log has a `staging failed` line with the same error, then `command not relayed`.
- **Why:** before the rig takes a campaign, its supervisor fetches the project, the kit and any model the command names. That fetch failed. The supervisor's log line `staged sources` means it worked.
- **Do:** read the reason:

| Reason after `staging:` | Do |
| --- | --- |
| `Git access <name>: control answered 404` | Control has no Git access of that name for this rig. Check the name in **Settings** (the cog at the foot of the sidebar) |
| `… has no commit …` | The commit is not in that repository, or the rig can't read it. For a private repository, see [Use a private repository](../campaigns/private-repository.md#5-check-that-the-rig-fetched-it) |
| `Command failed: git …` and git's message, such as `Host key verification failed` or `Permission denied (publickey)` | The rig can't read the repository. Give the campaign a [Git access](../campaigns/private-repository.md), or check the address |
| `<url>: HTTP <status>`, or `<url>: sha256 …, not …` | A model's address answered with an error, or its file is not the one the contract names |

## A campaign doesn't start: the kit does not fit the contract

- **You see:** the run never appears. On **Commands**, the **assign campaign** row is **failed**, and its **Outcome** has `the kit does not fit the contract:` and what doesn't fit, such as `cells names cell large, which the kit does not have` or `the kit measures on cuda-gpu, and this rig's target is cpu`.
- **Why:** when the rig takes a campaign, it checks the contract against the kit's `kit.json`. Every test case (a "cell" in `kit.json` and the contract), metric and verifier the contract names must be in the kit, and the kit's target must be the rig's. A kit with a broken `kit.json` fails with `has no valid kit.json:` instead.
- **Do:** fix the contract or the kit, then start the campaign again. See [Write a contract](../campaigns/write-a-contract.md) and [Write a kit](../campaigns/write-a-kit.md). For a kit described or uploaded on the **New campaign** page, the page runs the same check before it sends anything.

## Agents don't start

- **You see:** the harness's log says `agents wait for a model route`, and no trials start.
- **Why:** the rig has no model yet.
- **Do:** [connect a model provider](../models/connect-a-provider.md) and give the rig one of its models.

## Something was refused

Thermite says why it refuses something. Where you see it depends on how you asked:

- **The dashboard** shows `Not done.` and the reason on the rig and Providers pages. Some actions answer with a plain page that says `refused:` and the reason: use your browser's **Back** button.
- **The REST API** answers `401 {"error":"unauthorized"}` for a token that isn't the owner's, and `400 {"error":"invalid request"}` for a body with a wrong field, without saying which. Other refusals answer **500** with the reason, for example `{"error":"unknown rig rig-9"}` or `{"error":"bad pause_run payload: run: …"}`.
- **MCP** tools answer `{"error":"…"}` with the reason.
- **A rig** that refuses a command marks it `rejected` or `failed` on **Commands**, with the reason in **Outcome**. For example, `not now: …` for a busy rig, or `<kind> is the owner's to issue, not …'s` for a command only the owner may give.

Control writes the dashboard's refusals and failed requests to its audit log as well. To list them over MCP, call `control_log` with `action: "refused"` or `action: "failed"`.

## Still stuck?

See [Getting help](../../project/getting-help.md) for where to ask, and include the log lines you found.
