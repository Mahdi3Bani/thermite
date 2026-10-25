---
title: "Troubleshoot"
description: "Check the machine with thermite doctor, then find out why a check failed, a port clashes, a build is slow, a rig is quiet, a trial makes no progress, a message goes unread, a queue change doesn't take, a research run doesn't end, past research or an MCP server doesn't work, or a sign-in bounces back, and where the logs are."
type: how-to
sidebar:
  order: 9
---

Find the problem you see, then follow what to do. On a new machine, or when Thermite won't start, [check the machine](#check-the-machine) first. The problems are in five groups: [install and sign-in](#install-and-sign-in), [rigs](#rigs), [starting a campaign](#starting-a-campaign), [runs: trials, messages and the queue](#runs-trials-messages-and-the-queue), and [past research and MCP servers](#past-research-and-mcp-servers). A [rig](../../reference/glossary.md) is two containers: the harness, which holds the judge and the agents, and the supervisor, its link to control. Most problems leave a line in a log, so [Where the logs are](#where-the-logs-are) comes next. Most commands below are for the local compose stack; with Podman, write `podman compose` where they say `docker compose`. For a rig on a machine or a cluster, the table below gives the commands that read its logs, and the entries say what to read there.

## Check the machine

Most first-run problems are in the machine, not in Thermite. `thermite doctor` checks it: the container engine and its compose tool, control's port, free disk, the clock, the GPU driver and NVIDIA's container toolkit where there is a GPU, what the local rig gets (its CPUs, memory and GPUs), and whether control and the model server answer.

1. Run it on the machine that has the problem, in your `thermite-source` folder: the command line, built once from the source of the release you run, as [The command line](../install/one-machine.md#the-command-line) says. It needs Node.js 22.19 or later and git, and works before Thermite is started.

   ```sh
   npx thermite doctor --control http://127.0.0.1:8800 --model-url https://opencode.ai/zen/v1
   ```

   On a rig's own machine, give control's address for rigs instead, such as `https://control.example.com`. Give your own provider's address as `--model-url`, or leave it out. Before control runs, leave out `--control`.
2. Read each line. It starts with `ok`, `WARN`, `FAIL` or `skip`. A failure or a warning has a `Fix:` line under it:

   ```text
   FAIL  Control's port: Port 8800 is in use by another program. Control needs this port for its dashboard and API.
         Fix: Stop that program. To find it, run lsof -nP -iTCP:8800 -sTCP:LISTEN. Or use another port: put THERMITE_CONTROL_PORT=8801 in a .env file next to compose.yaml. Then run thermite doctor --port 8801.
   ```

3. Do what each `Fix:` line says, then run the doctor again.

The last line says `No check failed.` when the machine is ready. A check that says `skip` did not apply: for example, a machine without an NVIDIA GPU needs no GPU driver. The **Local rig** line says what the rig on this machine gets, and warns when the machine has NVIDIA GPUs that the rig can't have yet ([What the rig gets](../install/one-machine.md#what-the-rig-gets)). [Command line](../../reference/command-line.md#doctor) lists every check and its limits.

## Where the logs are

Every part of Thermite writes one JSON object per line, such as `{"at":"…","component":"supervisor","msg":"relay error","error":"…"}`.

| What | Where |
| --- | --- |
| Control, the harness and the supervisor of the local stack | `docker compose logs control`, `docker compose logs harness`, `docker compose logs supervisor`. Add `-f` after `logs` to follow them |
| A rig on a machine, set up by control or joined | On the machine, logged in over SSH as the user the rig runs as (not with `sudo -u`): `journalctl --user -u thermite-rig-1-supervisor.service`, and the same for `thermite-rig-1-harness.service`. For a rig that runs as root: `sudo journalctl -u thermite-rig-1-supervisor.service` |
| A rig on a cluster, set up by control or joined | `kubectl logs -n <namespace> deployment/thermite-rig-1-supervisor` (or `-harness`) |
| What a rig did | The rig's page: **Recent** for its history, **Checks** for its checks, and the **Set up by control** or **You run it yourself** block for each setup step. For a rig control set up, the MCP tool `rig_setup` lists the same steps |
| What a run's agents and advisors are doing | **Live** in the sidebar, or **Live** on the run's page: the run's lines as they come. Choose **Advisors** for each step of the advisors' rounds, with each advisor error and its reason. Choose **You** for your messages, who read them and the advisors' answers |
| What control did, refused or failed at | **Audit log** in the sidebar (300 entries a page, newest first: **Older** and **Newer** below the list go through the rest), `GET /v1/audit`, or the MCP tool `control_log`. Both page through every entry with `before` and `after`: see [the REST API](../../reference/rest-api.md#audit-log) and [`control_log`](../../reference/mcp-tools.md#control_log). Refusals, from the dashboard, an MCP tool or a command sent over the REST API, are entries named `refused`, and requests that ended in an error are named `failed`, each with the reason (for a refusal shown as a plain page, such as `bad form token`, only its HTTP status) |
| Where each command went | **Commands** in the sidebar: each command's status (`pending`, `delivered`, `rejected`, `failed`, `expired`) and the rig's answer in **Outcome** |

There is no single Logs page yet ([goal 027](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/027-logs-page.goal)).

## Install and sign-in

### Compose won't start: a secret file is missing

- **You see:** `docker compose up` stops with an error about a file in `.dev/secrets/`.
- **Why:** the local tokens don't exist yet. `compose.yaml` reads them from `.dev/secrets/`.
- **Do:** run `docker compose run --rm init` (or `podman compose run --rm init`) in the folder that holds `compose.yaml`, then start again. In a checkout of the source code, run `npm run dev:init` in the repository's top folder instead.

### Compose won't start: `'name' does not match any of the regexes`

- **You see:** `podman compose up` or `docker-compose up` stops with `The Compose file './compose.yaml' is invalid because: 'name' does not match any of the regexes: '^x-'`. With Podman, a line before it says `Executing external compose provider "/usr/bin/docker-compose"`.
- **Why:** the compose program is `docker-compose` 1.x, the old Compose v1. It can't read the `name:` at the top of Thermite's compose file. `podman compose` uses `docker-compose` first when it is installed, even when podman-compose is installed too. `thermite doctor` names the program on its **Compose tool** line.
- **Do:** remove `docker-compose` 1.x: `docker-compose version` shows it, and on Debian or Ubuntu `sudo apt remove docker-compose` removes it. Then install podman-compose (for example, `pipx install podman-compose`) or Docker Compose 2 or later, and start again. Or, with podman-compose installed, type `podman-compose` in place of `podman compose`.

### Control stops at start: `control needs the owner's credential`

- **You see:** control keeps restarting, and `docker compose logs control` has a `fatal` line that says `control needs the owner's credential`.
- **Why:** control has no owner's token. After you switch to an owner's token of your own, the token file is empty on purpose, and only the override file gives control the hash.
- **Do:** start the stack with both files: `docker compose -f compose.yaml -f compose.tokens.yaml up -d`. See [Use an owner's token of your own](../install/one-machine.md#use-an-owners-token-of-your-own).

### Control stops at start: `EPERM` on `control-signing.key`

- **You see:** control keeps restarting, and its log has a `fatal` line with `EPERM: operation not permitted, chmod '/var/lib/thermite-control/control-signing.key'`.
- **Why:** you added `compose.lifecycle.yaml` to a stack that had already run. See [Give control a deployment driver](rig-lifecycle.md#give-control-a-deployment-driver).
- **Do:** start the stack again without that file.

### The port is already in use

- **You see:** `docker compose up` fails because port 8800 is taken. `thermite doctor` says `Port 8800 is in use by another program.` before you start.
- **Why:** another program, or another Thermite stack, uses port 8800 on your computer.
- **Do:** stop that program, or choose another port: `THERMITE_CONTROL_PORT=8801 docker compose up -d`, or put `THERMITE_CONTROL_PORT=8801` in a `.env` file next to `compose.yaml`. The dashboard is then at `http://127.0.0.1:8801/ui`. Check the new port with `npx thermite doctor --port 8801`.

### The harness restarts at the first start

- **You see:** the harness's log has `timed out waiting for /keys/control-signing.pub`, and it starts again.
- **Why:** control writes its public key when it first starts, and the harness waits only two minutes for it.
- **Do:** nothing. The harness starts again by itself and finds the key.

### The harness doesn't start with `compose.gpu.yaml`

- **You see:** `up -d` with `-f compose.gpu.yaml` does not start the harness. Podman says `unresolvable CDI devices nvidia.com/gpu=all`; Docker gives an error about the `nvidia` device driver.
- **Why:** the engine can't give containers the GPUs: NVIDIA's container toolkit is missing, Podman has no CDI spec, or Docker has no NVIDIA runtime. The release's `init` writes `compose.gpu.yaml` from the GPUs that NVIDIA's driver lists, but from its container it can't check the toolkit.
- **Do:** in your `thermite-source` folder, run `npx thermite doctor`, and do what the `Fix:` line of its **GPU container toolkit** check says. Then start again with both files. To keep the rig on the CPU meanwhile, start without `-f compose.gpu.yaml`. See [Use the machine's NVIDIA GPUs](../install/one-machine.md#use-the-machines-nvidia-gpus).

### The first build is slow

- **You see:** in a checkout of the source code, `docker compose up -d --build` takes 20 minutes or more.
- **Why:** it builds three images from source, and the harness image installs compilers, Python and agent programs. A GPU image's base is a large download too. A release's `compose.yaml` downloads ready-made images instead ([Install Thermite on one machine](../install/one-machine.md)).
- **Do:** wait for it once. Later, start without `--build` (`docker compose up -d`) to reuse the images, and rebuild only what changed, for example `docker compose build harness`.

### The Podman VM runs out of disk or memory

- **You see:** builds fail partway, or the VM's disk fills up. The **Disk** line of `thermite doctor` shows how much space is free in the VM, and `podman system df` shows how much the images and volumes take.
- **Why:** on a Mac, Podman runs containers in a VM. Each build leaves old image layers behind, and each lane's compiler cache can grow to 8 GB.
- **Do:** free the space, then give it back to your Mac:

```sh
podman image prune -f              # remove untagged image layers only
podman machine ssh sudo fstrim -a  # give the freed space back to your Mac
```

Never prune tagged images: they may belong to other projects. For more memory or CPUs, stop the VM and change it with Podman's own command, `podman machine set --memory <MiB> --cpus <n>`.

### Sign-in comes back with no message

- **You see:** after **Sign in**, the sign-in page shows again.
- **Why:** the token is not the owner's. Only the owner's token signs in; an operator's, agent's or reader's token can't. A token with a space or a missing character fails too.
- **Do:** copy the owner's token again: `cat .dev/secrets/control-admin-token` on the local stack, or the file of the owner's token you made yourself. After 20 failures in a minute, the page says `too many failed sign-ins; wait a minute`.

A sign-in also ends when the owner's token changes, or after 30 days without use.

### A button answers `bad form token`

- **You see:** a plain page that says `bad form token` after you press a button.
- **Why:** the page was opened before your current sign-in, for example before you signed in again in another tab.
- **Do:** go back, reload the page and press the button again.

## Rigs

### A rig is quiet

- **You see:** the rig shows **Stale** or **Offline** on **Rigs**, or never appears there. Its page says `stale` or `offline`, with a banner.
- **Why and do:** for a rig control set up on a machine or a cluster, the banner says what control found when it checked where the rig runs, which it does by itself when the rig turns stale and again when it turns offline: whether its containers run, and, on a machine, the supervisor's last log lines. **Check again** (**Check the cluster**) checks now. Otherwise read the supervisor's log. Most causes show in a `relay error` line:

| In the supervisor's log | Why | Do |
| --- | --- | --- |
| `waiting for the harness` and nothing more | The harness isn't up | Read the harness's log |
| `the rig's key waits for the owner's acceptance` or `rig key changed: the owner must accept the new key` | Control holds the rig's key | [Accept the rig's key](accept-a-rig-key.md) |
| `this rig is retired in control` | The rig was retired | Bring it back on its page: see [Retire and bring back](rig-lifecycle.md#retire-and-bring-back) |
| `ingest -> 401` with `unauthorized` | The supervisor's control token is wrong | Give it the rig's current token: see [Rig tokens](tokens.md#rig-tokens) |
| `the harness reports as rig …, but this supervisor is …` | The two containers have different `THERMITE_RIG_ID` settings | Make them the same |
| `report from the future` | The rig's clock is ahead of control's | Set the clocks right. On the rig's machine, `thermite doctor --control` and control's address compares the two clocks |
| `Control cannot work with this rig: …` | Control refuses the rig: the protocol of its harness or supervisor and control's do not meet. The message says which part, and whether to update the rig's images or control | Do what the message says. `thermite rig list` shows each part's version ([Rig versions](../../reference/rest-api.md#rig-versions)) |
| No `relay error`, but the rig has never appeared | The supervisor has no control token file, so it reports nothing and logs no error | Check that the file its `THERMITE_CONTROL_TOKEN_FILE` names exists and holds the rig's token |
| `model route error` | Control or the harness did not answer when the supervisor asked for the rig's model, twice, 5 seconds apart. The rig keeps the model it has | Read the error in the line, and control's log. The supervisor logs this once, and again only after a round has worked |

A rig control set up on a machine or a cluster may also still be pulling its images. Its setup steps say `no report after 10 minutes: it may not have started` when it took longer than that; it may still report later. For a rig on a cluster, see [A rig on a cluster never reports](#a-rig-on-a-cluster-never-reports).

### Pushes to the results repository fail with `@@@@@@@@@`

- **You see:** the **Results** row on the rig's page says `push failed: Command failed: git … push …` and `@@@@@@@@@`.
- **Why:** ssh refused the deploy key. On a Mac with Podman, it refuses a key file at mode 644.
- **Do:** see [Set up the results repository](results-repository.md#3-give-the-supervisor-the-three-settings).

### An image update waits while the rig drains

- **You see:** on the page of a rig on a cluster, after **Update to these images**, the status `draining` and `Draining before its pods restart on control's images:` with the new images.
- **Why:** the rig was at work. It starts no new trial, plan or judge job, and its pods restart once its running trials and the judge's job end. A trial has no time limit unless someone set one, so this can take a while. A judge job whose lease ran out (its holder is gone) is not waited for: the rig takes it back, queued again, or `blocked` after its third lost lease. If the rig's harness started again during the drain, it forgot the drain and went back to work; after two reports without the drain, control sends it again, and the rig's history has the step `its harness started again and was not draining: asked again`.
- **Do:** wait; or press **Update now, without waiting**: its pods restart at once, and the running trials are recorded as interrupted, their experiments back at the top of the queue; or press **Call the update off**, and the rig goes back to work on its images. See [Update to these images](rig-lifecycle.md).

### A rig on a cluster never reports

- **You see:** in the rig's **Set up by control** block, the step "First report reached control" has ✕ and `no report after 10 minutes: it may not have started`, and the block says `failed`.
- **Why:** its pods have not started, or its supervisor can't reach control. Often the nodes are still pulling the large images. A pod stays `Pending` when no node has room for what it asks, such as its GPUs, CPUs, memory or volume. It shows `ImagePullBackOff` when the nodes can't pull the images: a registry that needs a sign-in is not supported yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
- **Do:** look at the pods, in the namespace the block shows:

  ```sh
  kubectl get pods -n <namespace> -l app.kubernetes.io/instance=rig-1
  kubectl describe pods -n <namespace> -l app.kubernetes.io/instance=rig-1   # its Events say why it waits
  kubectl logs -n <namespace> deployment/thermite-rig-1-supervisor          # relay errors, as in the table above
  ```

  When the rig reports later, the block says `running` again, and a ✓ step follows the ✕: "First report reached control · it reported after the wait ended". The ✕ stays in the list.

After **Update to these images**, **Start its pods** or **Restart them** ([Stop, restart, remove or reset a rig](rig-lifecycle.md#a-rig-on-a-cluster)), the same can happen to the new pods, with other steps:

- "Its pods run the new images" after an update, or "Its pods run again" after a start or a restart, has ✕ and `not running after 15 minutes`, sometimes with kubectl's error. The new pods did not start: look at them with the commands above. An image the nodes can't pull shows `ImagePullBackOff`.
- "A report reached control from the new images", or "A report reached control after the start", has ✕ and `no report after 10 minutes: it may not have started`. The pods run, but the supervisor did not report: read its log, as above. If the harness keeps restarting, read its log too (`deployment/thermite-rig-1-harness`).

Either way, the block says `failed`. A rig you stop or remove while control waits never gets these ✕ steps: the stop or the removal ends the wait. Fix the cause: the pods keep trying by themselves, for example once the nodes can pull the image. When the rig reports again, the block says `running`, and a ✓ step is named for the wait that ended: "A report reached control from the new images" after an update, or "A report reached control after the start" after a start or a restart, each followed by "· it reported after the wait ended".

To have control apply the images again and wait once more, press **Try the update again** in the block. It shows while the status says `failed`, after the line "The last change to its pods failed (see the steps above)." See [Try again after a failure](rig-lifecycle.md#try-again-after-a-failure). Over MCP, `update_rig_images` does the same. Either answers `rig-1's pods restart on control's images again (a retry).` If the new images themselves are at fault, you can go back to the old ones while the new harness never opened the rig's ledger, for example when the new pods never ran: see the caution "Going back to older images" in [A rig on a cluster](rig-lifecycle.md#a-rig-on-a-cluster). If the new harness did run, the older one may refuse the ledger: see [The harness stops at start: the ledger is newer](#the-harness-stops-at-start-the-ledger-is-newer).

### A RunPod rig never enrolls

- **You see:** on the rig's page, **Getting it ready** stays at "Control enrolls it through RunPod's proxy with its one-time code, and pins its keys", **The pod** says **Running** and the pod costs money, and **Pull mode** may show control's last error, such as a `502` from RunPod's proxy, or `the pod did not enroll (an empty 404). Most often nothing listens on the pod's port yet: …`. RunPod's proxy gives that empty 404 when nothing answers on the pod's port, the same answer a pod gives a request it refuses.
- **Why:** the pod runs, but what runs in it does not answer control. The rig image may have failed to pull or to start, its supervisor may have stopped at start, or the pod may have been launched with another image. Before enrollment, control sees nothing of the rig: the pod's log is the one place that says which.
- **Do:** read **Pod log**, under **Getting it ready** ([A rig's page](../../reference/rig-page.md#pod-log)). The first time the page opens, it reads the log by itself; after that it shows the last read, and **Read again** reads the newest lines. `system` lines are RunPod's own, such as the image pull; `container` lines are what the image printed, and the last of them usually says why it stopped. `system` lines `start container for … begin` again and again mean the container stops as soon as it starts: the rig image then holds a fatal error a minute before it exits, so its `fatal: …` line is in the `container` lines. Control reads the log from RunPod's API with the key in **Settings › Providers**, so you need no RunPod console. Over the REST API, `GET /v1/rigs/<rig>/runpod/logs`, or the MCP tool [`runpod_rig_logs`](../../reference/mcp-tools.md#runpod_rig_logs), gives the same lines.

  If the block says `Not read: RunPod refused to show pod …'s log with this key`, the key may not read pod logs: give control a key with read access to pods. Fix the cause, such as the image's name, then terminate the pod and launch the rig again ([Run a rig on RunPod](../install/runpod-rig.md)). The pod costs money while it runs: stop or terminate it if you can't fix it now.

  If the `container` lines say `could not chown the state volume`, or `EPERM: operation not permitted, chown '/workspace/thermite/…'`, the pod runs a rig image that kept the rig's state on the pod's volume. RunPod's volume refuses even root a change of owner, which that image needed to keep the rig's parts apart. The rig image now keeps the state on the pod's own disk and only a snapshot of it on the volume ([Where the state lives](../../reference/harness-image.md#where-the-state-lives)): terminate the pod and launch the rig again on the current image.

### A RunPod rig lost its state over a stop

- **You see:** after **Start the pod**, the rig reports with fresh records, or never reports again because it made new keys that control does not know.
- **Why:** the rig works on the pod's own disk, which RunPod empties at a stop, and its state comes back from the sealed snapshot on the volume ([Where the state lives](../../reference/harness-image.md#where-the-state-lives)). A start restores nothing when the pod has no snapshot key, when no snapshot could be taken, or when the snapshot did not verify: someone changed it, or it was deleted.
- **Do:** read **Pod log** ([A rig's page](../../reference/rig-page.md#pod-log)) for the broker's lines about the snapshot:
  - `no snapshot key: no snapshot is taken or restored`: the pod was launched without `THERMITE_STATE_SNAPSHOT_KEY`, by a control from before sealing. Terminate the pod and launch the rig again from the current control;
  - `the snapshot did not verify: <why>`: the manifest or a file in the snapshot was changed, cut short or removed, or it is another pod's. Nothing of it was restored, and the rig started with an empty state. A rig in pull mode then has no keys and can't enroll again by itself, since its one-time code is spent: control can't reach it. Terminate the pod and launch the rig again. Its results that had left the pod are on control. A change to the snapshot means a part or a role wrote on the volume: look at what ran on the rig before the stop;
  - `could not take a snapshot of the rig's state: the last one stays`, with its `error`: free room on the volume, or launch with a larger one;
  - `fatal: could not restore the rig's state from its snapshot`: the start stops, holds the error a minute and tries again, with the snapshot unchanged. Its `error` says why, such as a pod disk too small for the state;
  - `no snapshot at the stop: the last complete one stays`: the stop gave the rig too little time, and only what changed after the last snapshot is gone;
  - `no snapshot yet: the rig starts with a fresh state` after a stop: the snapshot is gone from the volume. As after a refused snapshot, terminate the pod and launch the rig again.

### The harness stops at start: the ledger is newer

- **You see:** the harness keeps restarting, and its log has a `fatal` line with `this ledger is at schema version 13, newer than this code's 12: run a newer Thermite, or restore the ledger from before the upgrade` (the numbers vary).
- **Why:** a newer harness opened the rig's ledger and upgraded it. An older harness never opens a newer ledger, so that it can't damage the record.
- **Do:** run the newer harness image again: on the compose stack, rebuild from the newer commit; on a rig on a cluster, set control's images to the newer ones and press **Update to these images**. The older harness changed nothing, so the rig goes on from where it was. Going back to an older version needs the ledger from before the upgrade ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).

### A join command stops at a check and then doesn't work

- **You see:** the join command stops with a line such as `thermite: Podman is missing: install Podman 4.4 or later, then make a new join command`. Run again, it fails with curl's `The requested URL returned error: 401`.
- **Why:** a join command works once. It is used up when the machine fetches its script, before the script checks the machine ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). The checks run before anything is written, so nothing was set up. In a namespace, a `kubectl apply` that fails uses the command up too.
- **Do:** fix what the message names. Then, on the rig's page, press **Make a new join command** and run the new one. After a failed check there is nothing to remove first, although the card asks you to. See [Join a rig yourself](../install/join-a-rig.md#4-make-a-new-one-or-revoke-it).

### A check failed

- **You see:** **Model route**, **Isolation** or **Judge smoke** shows **failed**.
- **Do:** read its sentence, and see [Check a rig](check-a-rig.md#read-the-result).

Two causes are common on a laptop:

- `not now: …`: the rig has open trials or judge jobs. Make it idle as [Check a rig](check-a-rig.md#before-you-start) says, then run the check again.
- **Judge smoke** fails with some candidates "judged otherwise", and the harness's log has `job failed` lines that say `target not ready for timing: load … above 75% of … cores`. The computer was too busy for fair timing. Close other heavy programs and run the check again.

### Judge smoke passed with a note

- **You see:** **Judge smoke** shows **passed**, with `the no-op came out inconclusive, not neutral` and `Note: The timing on this machine is noisy. Results here need more repeats.`
- **Why:** the no-op is a change that does nothing. The judge could not tell it from the noise in this machine's timing, so it said `inconclusive`, not `neutral`. Every other known change got its right verdict, so the judge works here. This is common on a virtual machine that shares its host, and on a busy laptop.
- **Do:**
  1. Nothing is broken: the rig can run campaigns.
  2. For campaigns on this rig, give the judge more repeats. On the **New campaign** page, raise **Runs per case**; in a contract, raise `acceptance.runs_per_cell` (see [the contract reference](../../reference/contract.md)). More repeats make each verdict take longer.
  3. To get a clean pass, close other heavy programs, or use a machine that doesn't share its CPU, and run the check again.

  See [Noisy timing](../../reference/rig-checks.md#noisy-timing) in the rig checks reference.

### The isolation check failed

- **You see:** **Isolation** shows **failed**, with `isolation does NOT hold (devices: …):` and up to 12 items such as `agent-1 ledger: ALLOWED`.
- **Why:** each item is a role and a probe. `ALLOWED`: the role's user reached something it must not, such as the judge's files or a secret. `UNREADABLE`, `UNREACHABLE` or `WRONG GPUS`: a role was refused something it needs, or saw other GPUs than its own. `the device setup failed`: the rig's GPUs could not be split between the judge and the agents; the `devices:` part says why.
- **Do:**
  1. Pause the rig's runs, and start none on it until the check passes.
  2. Look up each probe in the [rig checks reference](../../reference/rig-checks.md#isolation-check). [Isolation inside a rig](../../explanation/isolation.md) explains what keeps each role apart.
  3. On an image you extended, compare with Thermite's own image ([Extend the harness image](../install/extend-harness-image.md)). For the device setup, check the rig's GPU settings ([Use several GPUs](../install/several-gpus.md)).
  4. Run the check again after each change. The harness also runs it every time it starts.

  If it still fails on Thermite's own image, ask for help with the whole sentence: see [Still stuck?](#still-stuck).

### A rig can't reach a model server on your network

- **You see:** **Model route** fails with `no answer in 120 s (is the model up?)`, or with `no tool call:` and a connection error, while the server answers on your computer.
- **Why:** the rig calls the model from its harness container. Inside a container, `localhost` is the container itself. A rig on a cluster reaches only DNS and addresses outside the private ranges, so a server on a private address is out of its reach.
- **Do:** on the local stack, use `host.docker.internal` in the provider's address (`host.containers.internal` with Podman). Give a rig on a cluster a hosted provider. See [Choose a model](../models/choose-a-model.md#2-a-model-server-on-your-own-computer). To check that the server answers at all, run `npx thermite doctor --model-url` with the provider's address: it checks `host.docker.internal` at `127.0.0.1`.

## Starting a campaign

### A campaign doesn't start: `staging:`

- **You see:** the run never appears. On **Commands**, in the sidebar, the **assign campaign** row is **failed**, and its **Outcome** holds `{"error":"staging: …"}`. The supervisor's log has a `staging failed` line with the same error, then `command not relayed`.
- **Why:** before the rig takes a campaign, its supervisor fetches the project, the kit and any model the command names. That fetch failed. The supervisor's log line `staged sources` means it worked.
- **Do:** read the reason:

| Reason after `staging:` | Do |
| --- | --- |
| `Git access <name>: control answered 404` | Control has no Git access of that name for this rig. Check the name in **Settings** (the cog at the foot of the sidebar) |
| `… has no commit …` | The commit is not in that repository, or the rig can't read it. For a private repository, see [Use a private repository](../campaigns/private-repository.md#5-check-that-the-rig-fetched-it) |
| `Command failed: git …` and git's message, such as `Host key verification failed` or `Permission denied (publickey)` | The rig can't read the repository. Give the campaign a [Git access](../campaigns/private-repository.md), or check the address |
| `<url>: HTTP <status>`, or `<url>: sha256 …, not …` | A model's address answered with an error, or its file is not the one the contract names |

### A campaign doesn't start: the kit does not fit the contract

- **You see:** the run never appears. On **Commands**, the **assign campaign** row is **failed**, and its **Outcome** has `the kit does not fit the contract:` and what doesn't fit, such as `cells names cell large, which the kit does not have` or `the kit measures on cuda-gpu, and this rig's target is cpu`.
- **Why:** when the rig takes a campaign, it checks the contract against the kit's `kit.json`. Every test case (a "cell" in `kit.json` and the contract), metric and verifier the contract names must be in the kit, and the kit's target must be the rig's. A kit with a broken `kit.json` fails with `has no valid kit.json:` instead.
- **Do:** fix the contract or the kit, then start the campaign again. See [Write a contract](../campaigns/write-a-contract.md) and [Write a kit](../campaigns/write-a-kit.md). For a kit described or uploaded on the **New campaign** page, the page runs the same check before it sends anything.

### A campaign doesn't start: the commit has no folder

- **You see:** the run never appears. On **Commands**, the **assign campaign** row is **failed**, and its **Outcome** has `commit <commit> has no folder <folder>`. On the **New campaign** page, **Look it up** says `main has no folder examples/none, or the folder has no files` (with your branch and folder).
- **Why:** the campaign's project is one folder of its repository (**Folder in the repository**, or `project.folder` in the contract), and the commit the run starts from has no such folder. The path is from the top of the repository, and git's names are case-sensitive.
- **Do:** check the folder's path on your Git host, at the branch or commit you start from. Then open **New campaign** again, fill it in with the same campaign name and the folder fixed, and start it. See [Start a campaign from the dashboard](../campaigns/start-from-dashboard.md#3-project).

### Agents don't start

- **You see:** the harness's log says `agents wait for a model route`, and no trials start. Or the **New campaign** page won't start the run: `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model".` On a campaign's page, **Start a run** says **Not started.** and `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model", or give it one on its Edit rig page.`
- **Why:** the rig has no model yet. A run without agents (**Agents**: **Off: a try**) needs none.
- **Do:** [connect a model provider](../models/connect-a-provider.md) and give the rig one of its models, on **Settings › Providers**, or under **The agents' model** on the **New campaign** page or in the **Start a run** panel. The rig takes it within a minute. Until then, **Start the campaign** saves the campaign instead of starting it, and **Start the run** starts nothing. Each says so and points to **Settings › Providers**, which shows the rig taking the model until it has it, for example `rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that.` [When the rig doesn't have the model yet](../campaigns/start-from-dashboard.md#when-the-rig-doesnt-have-the-model-yet) says how to start the run then. If the rig's model check fails, no trial starts either: see [The agents stopped: the provider refuses](#the-agents-stopped-the-provider-refuses).

### The agents stopped: the provider refuses

- **You see:** under **Needs you**, an **Agents stopped** card: `The model provider refuses: no credits left at the provider` (or `the provider refuses the key`, `the provider does not serve this model on this key`, or `The model check of the workers' model fails`), with the provider's own words, such as `404 insufficient_credits_for_paid_model`. Or `The model's calls keep failing: no model call worked for 30 minutes (the provider failed for now)`, with the newest error's words, such as `503 Service Unavailable`. The run's **History** says `The agents stopped: no credits left at the provider (…). No trial starts until a model check passes.` No trial or plan starts. A research run's clock stops.
- **Why:** a trial got that answer from the model provider, or the workers' model check failed. Trying again would get the same answer, so the run's agents stop, instead of starting trial after trial that dies the same way. A passing fault or a request the provider refused, which a trial waits out and goes on from, stops the agents the same way once no model call has worked for 30 minutes: a fault that never clears shows here instead of looping unseen. The judge goes on with the changes it has.
- **Not this:** a trial that failed on its own, such as a workspace it could not set up (`EACCES: permission denied`) or a program that exited, never stops the agents, even when its words sound like the provider's. It shows as that trial's error, and the next trial starts.
- **Do:** fix the cause: add credits at the provider; check the provider's key in **Settings › Providers**; check that the provider is up; or give the rig another model on **Edit rig**. Thermite checks the model again after a minute, then less often, at most every 30 minutes. Press **Check the model now** on the card to check at once; a paused run you resume is checked at once too. Once a check passes, or the rig has another model, the agents go on: **History** says `The agents go on: a model check passed.`, and the card goes away. After calls that kept failing, the lane whose trial ended starts a fresh trial: a conversation the provider kept refusing is left behind.

### Trials wait for the provider

- **You see:** in a trial's **Live**, `waiting until 03:14:20 UTC: the provider's rate limit (429 Rate limit reached …). The trial goes on in the same conversation.`, or `the provider failed for now (503 Service Unavailable)`, or `the model's stream went silent for 600 s: retried at 03:14:20 UTC, in the same conversation.` ([A trial makes no progress for a long time](#a-trial-makes-no-progress-for-a-long-time)). The run's **History** may say `The agents wait for the provider's limit until 2026-10-22 03:14 UTC (…)`.
- **Why:** the provider asked for a pause (a rate limit), or failed for now (an outage). The trial waits for the time the provider gives (its `Retry-After`, its rate-limit reset headers, or its words), or a growing pause when it gives none, and then goes on where it was. No new trial starts on the rig until a rate limit's time. Nothing ends the trial for this unless the campaign sets `lanes.limits.failures_in_a_row`, or no model call has worked for 30 minutes: then the agents stop and the run shows in **Needs you** ([The agents stopped](#the-agents-stopped-the-provider-refuses); [Limits and pacing](../../reference/limits-and-pacing.md#the-model-provider)).
- **Do:** nothing. If it happens all the time, the provider's limits are too low for the rig's workers: lower **Workers at a time** on **Edit rig**, or raise the provider's limits.

### A research campaign's trials all end in errors

- **You see:** each trial of a research run ends at once with an error that names the model.
- **Why:** research workers run in Pi or OpenCode v2, and the rig's model can't serve them there:

| The error | Do |
| --- | --- |
| `this rig has no model for its agents: give it one on its Edit rig page` | Give the rig a model: see [Agents don't start](#agents-dont-start) |
| `research workers run in Pi or OpenCode, and a Claude subscription runs only in Claude Code: give this rig another model for research` | Give the rig a model from another provider |
| `<model> is one of OpenCode's own models, which work only inside OpenCode: set this rig's agents' harness to OpenCode on its Edit rig page` | Set the workers' **Runs in** to **OpenCode v2** on **Edit rig** |

The dashboard refuses to start a research run with agents in the last case. A run started from the command line, or on a rig whose model changed after the start, can still meet it. See [Write a contract](../campaigns/write-a-contract.md#4-write-a-research-campaign).

## Runs: trials, messages and the queue

### A trial stopped without a "trial ended" line

- **You see:** in a run's **Live**, a lane's trial started, but no "trial ended" line follows it. The lane's next trial may already have started.
- **Why:** the rig's harness restarted while the trial ran, for example after **Restart them**, **Update now, without waiting**, a restart with your compose tool, or a crash. (**Update to these images** waits for the running trials to end first.) A restart stops the running trials. As it stops, the harness records them as `interrupted`, with the turns and tokens their workers last reported, without a "trial ended" line; after a crash, it does so when it starts again. Control shows a trial as working only while the rig says it is at work, or for 15 minutes after its last line.
- **Do:** nothing. The lane goes on with a new trial. A trial that had not submitted gives its experiment back to the top of the queue: see [An experiment came back at the top of the queue](#an-experiment-came-back-at-the-top-of-the-queue). One that had submitted is done with that change, which the judge goes on with.

### A trial makes no progress for a long time

- **You see:** a lane's trial in **Live** has no new line for many minutes, while the rig reports it at work. Then, after 10 minutes with nothing from the model, `the model's stream went silent for 600 s: retried at 16:40:35 UTC, in the same conversation.` In OpenCode or Codex: `the model's stream went silent for 600 s: retried. The harness broke the call off; the trial goes on in the same session.` The harness's log has `a model call's stream went silent: retried`, with the trial, the run and `seconds`. For a call through the model proxy (OpenCode, Codex), or a planner's call or a model check, it has `the model's stream went silent for 600 s: the call is broken off and retried`; for an advisor's call, the supervisor's log has that line.
- **Why:** the model provider kept the call open and sent nothing more: no token, no error and no end. A gateway in front of the model may even keep the connection alive with comment lines (`: OPENROUTER PROCESSING`) while the model behind it sends nothing, so no client timeout ever fires. After 600 s with no data, the harness breaks the call off and counts it as the provider's passing fault: the trial waits a few seconds and goes on where it was ([Limits and pacing](../../reference/limits-and-pacing.md#the-model-provider)). A call that keeps sending data is never cut, however long it takes. Claude Code on a subscription reaches Anthropic directly and is not watched this way.
- **Do:** nothing for one silent call. If it keeps happening, the provider or the way to it is at fault: once no model call has worked for 30 minutes, the run's agents stop and the run shows in **Needs you** ([The agents stopped](#the-agents-stopped-the-provider-refuses)). Check the provider's status, or give the rig another model on **Edit rig**. A model that thinks for longer than 10 minutes without sending anything needs a longer wait: set [`THERMITE_MODEL_STALL_SECONDS`](../../reference/settings.md#the-rigs-own-model) on the harness and the supervisor.

### A trial's conversation was compacted

- **You see:** in a run's **Live**, a trial says `The harness compacted the conversation (compaction 1) at about 104,000 tokens, down to about 9,100. The trial goes on.`, then `The summary after compaction 1:` and the summary. With OpenCode v2, Codex or Claude Code the line starts with that program's name instead. The run's **History** has a line for it too, without the summary.
- **Why:** the trial's conversation neared the model's [context window](../../reference/glossary.md): by default, 80% of it. The harness kept the whole conversation in the run's research folder, under `compactions/`, and replaced the older turns with a summary. The agent can read the kept conversation; the run keeps it. With OpenCode v2, Codex or Claude Code, the program compacted the conversation itself, and the harness kept it from the program's own record (Claude Code's transcript, Codex's rollout, or the session that Thermite's OpenCode plugin saved); the kept file's first lines say which. A kept file whose title ends `as Thermite saw it` holds the lines **Live** showed instead: the program's own record could not be read, for example because Thermite's OpenCode plugin or Claude Code's hook did not run in that image.
- **Do:** nothing: the trial goes on. To compact at another share of the window, type it in **Compact at** in the agent's **Context** cell on **Edit rig**, or set `compact_at` with its model over MCP or REST, or set the campaign's own: see [Set when a conversation is compacted](../models/connect-a-provider.md#set-when-a-conversation-is-compacted) and [Set a campaign's own context window](../models/model-per-agent.md#set-a-campaigns-own-context-window). An advisor's call compacts too: its line in **Live** starts with `advisor <name>: its conversation was compacted`, and the supervisor keeps the conversation with its records. A trial that ends as `context` says why in its "trial ended" line, such as `the conversation does not fit the model's context window of 131,072 tokens even after compaction (about 140,000 tokens: the brief or one message is too large)`: shorten what the brief carries, or give the rig a model with a larger window.

### A message to the agents was refused

- **You see:** after **Send** in **Live**, your message never shows in the stream, and the line under the message box says why:
  - when control refused the message, `Not sent:` and its reason show at once, what you wrote stays in the box, and the message is not on **Commands**;
  - when the rig refused it, the line says `rig-1 refused it:` and the rig's reason, within seconds and with no refresh, and a strip above the box says **Not sent.** `The rig refused your last message:` and the reason. On **Commands**, the message's **message agent** row is **failed**, with the rig's reason in **Outcome**.

  The rig's refusal stays until a later message to the run goes through, and shows also for a message sent over MCP, the REST API or the command line. A message from **Tell the planner**, on a run's **Planner** tab, shows its refusal in that card, above the box.
- **Why:** a message that nothing would read is refused. Control refuses, before signing it, a message with no words (`Write a message first.`), and one to a recipient that **Live** greys out, with the same words: everyone working, a lane or the planner of a run without agents, such as a try; a part that is off on **Edit rig**, such as `The planner is off on this rig (Edit rig), so nothing would read it.`; an advisor the rig's supervisor hasn't set up, such as `This rig's supervisor has no auditor set up, so nothing would read it.`; the planner or the auditor of a research run; or the review panel of a run with no goal it reviews, such as a hill climb (a research run's review panel reads messages). The rig refuses what control can't check, such as a lane the run doesn't have. [Steer a run](../campaigns/steer-a-run.md#if-a-message-doesnt-arrive) lists control's reasons, and [`message_agent`](../../reference/signed-commands.md#message_agent) the rig's.
- **Do:** write to a recipient that the **To** list in **Live** doesn't grey out, switch the part on, on **Edit rig**, or give the advisor a model. Control's refusals are in the **Audit log**, as `refused` entries, from the dashboard, MCP and the REST API alike.

### A message shows, but nobody reads it

- **You see:** your message shows in **Live**, but no "✓ … read your message" line follows.
- **Why:** each agent reads a message at a set time, and the box's placeholder says when. An OpenCode, Claude Code or Codex worker, for example, reads it only when its model stops by itself, which can take many minutes; the auditor and the review panel only with their next audit or review. [When each agent reads it](../campaigns/steer-a-run.md#when-each-agent-reads-it) gives each reader's timing.
- **Do:** wait. To have every new trial of a lane, or of all lanes, read a message, keep it in force with 📌 when you send it.

### A change to the queue or a rule didn't take

Each run has an [experiment queue](../campaigns/choose-what-runs-next.md): the experiments up next, in order, which the planner gives to free lanes, and the lanes' ideas, which wait for the planner or you.

- **You see:** on a run's **Experiments** or **Planner** tab, you pressed **Add**, **↑ Top**, **Save** under **Edit**, **Drop it**, **Queue it**, **Drop** or **Remove**, or dragged an experiment. A line said `Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it.`, then `rig-1 refused it:` and the rig's reason, and the tab doesn't change. On **Commands**, the command's row, such as **queue move** or **drop directive**, is **failed**, with the rig's reason in **Outcome**.
- **Why:** most often, the queue changed on the rig before your command reached it. A lane took the experiment, or the planner queued or dropped an idea first. A change that worked shows on the tab after the rig's next report, within a minute by default.
- **Do:** act on what the tab shows now: it is drawn again when the rig answers.

A reason about one experiment names its state, then the rule: `only queued experiments move` after **↑ Top** or a drag, `only proposed or queued experiments can be edited` after **Save** under **Edit**, and `only proposed or queued experiments can be dropped` after **Drop**. For example, `experiment x-3f2a9c41d07e is assigned: only queued experiments move`.

| Reason in **Outcome** | Why |
| --- | --- |
| `experiment x-… is assigned: …` | A lane's trial is working on it: it shows under **In progress** |
| `experiment x-… is done: …` | Its trial has ended: it is under **Tried** |
| `experiment x-… is dropped: …` | Someone dropped it first: **Tried** says who, and why |
| `experiment x-… is queued, not a proposed idea` | The planner queued the idea before you pressed **Queue it** |
| `no experiment x-… in run run-1` | The run has no experiment with that id |
| `no rule 4 in force in run run-1` | The rule was removed already, or replaced, for example by the teachers' next set of rules |
| `run run-1 is closed: its queue and rules no longer change` | The run has finished |

### An experiment came back at the top of the queue

- **You see:** an experiment that a lane already worked on is first under **Up next** again, with `Came back once: its trial never really tried it` and why. The run's **History** says, for example, `"…" went back to the top of the queue: its trial on lane-2 was interrupted (its trial was stopped).` or `… ended on the provider's error (no model call worked for 30 minutes (the provider failed for now): 503 Service Unavailable).`
- **Why:** when a trial ends because it was interrupted, by **Pause**, **Restart the lanes** or a restart of the harness, or on the model provider's error (a rate limit, an outage, no credits, a refused key, or calls that failed until the agents stopped), its experiment was not really tried. It goes back to the top of the queue, with how many times and why.
- **Do:** nothing, or press **Drop** on it if it should not be tried again. It is the same experiment, not a copy: the queue does not fill up with repeats. A trial that ended for another reason, such as its time running out, a memory limit or a workspace it could not set up, doesn't come back: the experiment is tried, and **Tried** says how its trial ended. Nor does one interrupted after it submitted its change: the experiment is done with that change, which the judge goes on with.

### History says a round followed the fixed rules

- **You see:** in a run's **History**, a round's line says why the planner's model didn't plan it, such as `The planner planned round 3 (by the fixed rules: no model): lane-1 on loop-tiling.` The words in brackets name the cause:
  - `(by the fixed rules: the model gave no usable plan, because …)`: in two tries, the model gave no plan, or a plan that code refused. After `because` comes each try's cause in words, with its detail: `it answered in text without a plan`, `its reply was cut off at the output limit`, `the provider failed` (with the provider's words), `it ran out of time`, `it was cancelled`, or `the plan was refused` (with each rule it broke), such as `try 1: its reply was cut off at the output limit (…); try 2: the plan was refused (…)`;
  - `(by the fixed rules: no model)`: the rig has no model for the planner, of its own or the workers';
  - `(by the fixed rules: the planner is off on this rig (Edit rig))`: the **Planner** switch is off on **Edit rig**.

  The planner's line in **Live** says the same, such as `round 3: taken from the queue by the fixed rules (no model)`.
- **Why:** the lanes took experiments from the queue in order, by fixed rules: they skip directions that an **Avoid** rule names, and take those that an **Always** rule, then a **Try** rule, names first. Every rule names a direction, so the fixed rules keep them all; only an old rule in words, marked `words`, needs the planner's model, which converts it at its next round ([Old rules in words](../campaigns/choose-what-runs-next.md#old-rules-in-words)). A new direction that a **Try** rule names waits for the model to design it. See [Directions](../campaigns/choose-what-runs-next.md#directions).
- **Do:** nothing is lost: the run goes on. If it happens every round, open the run's **Planner** tab. The **The planner** card names the planner's model, or says `No model: the lanes take the queue in order and keep to the rules.`, and counts the rounds, such as `12 rounds so far: 10 planned by the model, 2 in queue order by the fixed rules …`. Give the planner a model on **Edit rig**, or switch it on there ([Give each agent its own model](../models/model-per-agent.md)).

### A research run doesn't end

- **You see:** a research run goes on long after its **Run for at least** time. On its **Overview**, under **Research questions**, the **Answer check** line says what it waits for.
- **Why:** after its minimum duration, a research run ends only when the rig's review panel finds every question answered, or when its `max_duration` is over, if the contract sets one ([When a research run ends](../../explanation/campaign-modes.md#when-a-research-run-ends)). **Answer check** says, for example:
  - `Waiting for a verified claim on question 2.`, or `Waiting for verified claims: 12 of the 40 the campaign asks for.`: the review panel is asked only once every question has a verified claim and the run has the campaign's floor of verified claims;
  - `The check waits for a review panel: this rig's supervisor has no review panel set up. The run keeps researching.`, or `… the review panel is off on this rig (Edit rig). …`;
  - `Not yet: review 3 found gaps: …`: a reviewer found a question not answered, or an answer did not pass code's check of its claims and numbers. What each reviewer found missing is in the run's **Journal**, by `panel:` and the reviewer's name, and in the workers' next briefs. The review panel is asked again only on new evidence;
  - `The review panel found every question answered (review 3). It waits for your acceptance in Needs you.`: the run asks you about reviews;
  - `Answered: … The final writer is writing the paper …`: the questions are answered, and the run ends once its research paper is in and its running trials end.

  When a reviewer gives no answer, **Live** says, for example, `review 3: 1 of 2 reviewers of the review panel answered (reviewer-2: …)`. The review is tried again every 30 minutes, and its fifth try posts it as not passed.
- **Do:** give the rig a review panel, or switch it on, on **Edit rig** ([Configure advisors](advisors.md)); accept the review under **Needs you** ([Reviews](../campaigns/decide-what-waits.md#reviews)); or end the run now with **Close run**, which writes its final report ([Close a run](../campaigns/steer-a-run.md#close-a-run)). For an end time in later runs, the contract's `max_duration` ends a run at the latest, answered or not ([Contract](../../reference/contract.md#research)).

## Past research and MCP servers

### A run gets no past research

- **You see:** you expect a run to have **past research**: the records of its campaign's other runs, and of the campaigns listed under **Can read from** in the **Knowledge** section of the campaign's page. Its rig's supervisor fetches them from control, and the harness writes them into the run's `knowledge/` folder, for the workers to search. But the supervisor's log has no `past research synced` line, or it has `past research sync error`.
- **Why and do:**
  - **There is nothing to send yet.** A run never gets its own records, only those of its campaign's other runs and of the folders under **Can read from**. A campaign's first run, with nothing under **Can read from**, gets none. **Knowledge** in the sidebar shows how many items each folder holds. To add another campaign's folder, see [Use past research in a new run](../campaigns/use-past-research.md).
  - **The sync hasn't come yet.** The supervisor syncs every 3 minutes, and only the runs that are running: a paused run gets its items once it runs again. Its setting is `THERMITE_KB_SYNC_SECONDS` (180); `0` turns the sync off ([Settings](../../reference/settings.md#how-often-it-talks-to-control)). A supervisor without control's address and token syncs nothing.
  - **Control didn't assign the run.** Control sends past research only for a run it assigned to that rig. For any other run, such as the `check-smoke-…` run of a rig's **Judge smoke** check, control has nothing: the supervisor logs no error, and asks about that run again after an hour. A run control assigned but hasn't seen the rig report yet gets its items at the next sync after the rig's report.
  - **The sync failed.** `past research sync error` names each run with its error, once until a sync works again, such as `<run>: control's knowledge base: HTTP` and the status control answered.
  - **Control couldn't index the rig's reports.** The **Audit log** has a `kb_failed` entry with the error, and control's log has `knowledge base catch-up failed`. Control tries again with the rig's next report.

### An MCP server fails its check

- **You see:** on **Settings › Providers**, in **MCP servers**, the server's row is red and says why. After **Add and read its tools**, **Save and read its tools** or **Read tools again**, the block says **Not done.** and, for example, `gbrain is kept, but the server answered 401: check the key.`
- **Why and do:** control signed in to the server and read its tools, or tried to:

| The reason | Do |
| --- | --- |
| `the server answered 401: check the key` (or `the client secret`, `the sign-in`) | The server refused the sign-in. Paste the key again in **New value**, or the secret in **New client secret**, and press **Save and read its tools**. For OAuth, press **Sign in again ↗** |
| `can't read its tools:` and the error | Control could not connect, or the server did not answer as an MCP server. Check the **MCP URL**: the server's streamable HTTP or SSE address, as control reaches it |
| `its key cannot be opened: enter it again` or `it has no key: enter it again` | Control can't open the sealed key, for example after its secrets key changed. Paste the value in **New value** |
| `Its token could not be opened at the update. Enter the key again.` | A server made from an outside knowledge base at the update to 0.1.0 whose token control could not open. Paste `Bearer` and the token in **New value** |
| `the server gave no token for its client ID and secret:` and the server's error | Check **Client ID**, **New client secret** and **Scopes** against the server's settings |
| `The sign-in ended. Sign in again.` | The server refused to renew the OAuth sign-in. Press **Sign in again ↗** |
| `its sign-in could not be renewed:` and the error | Control could not reach the server's sign-in service to renew the OAuth sign-in. Press **Read tools again** once the server answers. If it goes on, open the row and press **Sign in again with another account ↗** |
| `The server does not register clients by itself. Register Thermite on the server, then give its client ID here.` | Register Thermite as a client on the server, with the callback `/v1/mcp-oauth/callback` on control's address, and put its client ID in **Client ID** |
| `Can't find the server's sign-in:` or `The server did not register Thermite:` and the error | The server gives no OAuth sign-in that control can find or use. Check the **MCP URL**, or give a **Client ID** that the server made for Thermite |
| `The server did not sign Thermite in` or `The server did not take the sign-in:` and the reason | You said no on the server's page, or the server refused the sign-in. Press **Sign in ↗**, or **Sign in again ↗**, and allow Thermite |
| `This sign-in is not known, or was used already. Start it again.` or `This sign-in took more than 15 minutes. Start it again.` | Press **Sign in again ↗**, and finish on the server's page within 15 minutes |

### An MCP server fails during a run

- **You see:** in a run's **Live** view, once, `the MCP server gbrain failed: <why>. The workers go on without it.` (`The planner goes on without it.` for the planner, `The advisors go on without it.` for the advisors). The rig's events (`GET /v1/rigs/<rig>/events`, or MCP's `recent_events`) have an `mcp_server_failed` event with the server, the kind of agent and the reason, and the run's **History** tab says `The MCP server gbrain failed for the workers: <why>. The run goes on without it.` An agent's call came back as a tool error, `The MCP server gbrain failed: <why>. Go on without it.`, or `The MCP server gbrain can't be used now: <why>. Go on without it.` when the rig never got the server.
- **Or:** as the run's work starts, `the run goes on without the MCP server gbrain (control has not given it to this rig yet), after waiting 120 s. A later trial gets each one once the rig has it.` The run's first plan and trial waited for the server, and it did not come: see [Before the first trial](../campaigns/give-agents-mcp-tools.md#before-the-first-trial).
- **Why:** the server did not answer, refused the call, or the rig has no sign-in for it: `control can't sign in to it: …` (its sign-in ended, its key can't be opened), or `Settings has no MCP server of that name now` (it was deleted after the run started). A rig gets a server's sign-in on the same beat as its model route, every 30 seconds. `control has not given it to this rig yet`: the rig's supervisor has not handed it over; it does so on that beat, unless it cannot reach control.
- **Do:** nothing stops: the run goes on, and the agents work without the server's tools. Fix the server on **Settings** (its row says why), and the next call that works records `mcp_server_back` and says `the MCP server gbrain works again.` in **Live**. An advisor with `fetch_domains` `"*"` gets no MCP server at all, by design: see [Advisors file](../../reference/advisors-file.md#mcp-servers).

### A run does not start: the kit names an MCP server

- **You see:** `The kit names the MCP server paper-search, and Settings has no server of that name. Add an MCP server named paper-search in Settings › Providers, or take it out of the kit. Then start the campaign again.`; or, on **Commands**, a failed `assign_campaign` whose outcome says `the kit names the MCP servers …, and the assignment names …`.
- **Do:** add the server in **Settings** with that exact name, or take it out of the kit. From **New campaign**, the campaign is saved all the same: then press **Start the campaign** again, or start the saved campaign with **Start a run** on its page. A run assigned with `thermite assign` or over MCP needs the kit's list in its `mcp_servers` ([Give agents MCP tools](../campaigns/give-agents-mcp-tools.md#3-start-the-run)).

## Something was refused

Thermite says why it refuses something. Where you see it depends on how you asked:

- **The dashboard** shows `Not done.` and the reason on the rig and Providers pages, `Not started.` in a campaign's **Start a run** panel, and `Not sent:` and the reason under the message box in a run's **Live** and in **Tell the planner** on its **Planner** tab. A button that sends something to a rig shows `Not sent:` and the reason beside it, or at the top of the page. Without the page's script, some actions answer with a plain page that says `refused:` and the reason: use your browser's **Back** button. A command that control sent but the rig refused shows as **failed** on **Commands**, as for the [queue](#a-change-to-the-queue-or-a-rule-didnt-take).
- **The REST API** answers `401 {"error":"unauthorized"}` for a token that isn't the owner's, and `400 {"error":"invalid request"}` for a body with a wrong field, without saying which. A command that control refuses answers **400** with the reason, for example `{"error":"bad pause_run payload: run: …"}` or a message that nothing would read, or **404** `{"error":"unknown rig rig-9"}`; control's audit log has it as a `refused` entry, with the kind and the reason. Other refusals while control does the work, such as a refused propagation, answer **500** with the reason.
- **MCP** tools answer `{"error":"…"}` with the reason, and control's audit log has it as a `refused` entry, with the tool's name. A command kind that the token may not issue, such as `queue_add` with an agent's token, fails the tool's own input check with `Input validation error` instead, and leaves no audit entry.
- **A rig** that refuses a command marks it `rejected` or `failed` on **Commands**, with the reason in **Outcome**. For example, `not now: …` for a busy rig, or `<kind> is the owner's to issue, not …'s` for a command only the owner may give.

Control writes the dashboard's `Not done.`, `Not started.` and `refused:` answers, its own `Not sent.` refusals of a message, the MCP tools' refusals, and failed requests, to its audit log as well. To list them over MCP, call `control_log` with `action: "refused"` or `action: "failed"`.

## Still stuck?

See [Getting help](../../project/getting-help.md) for where to ask, and include the log lines you found and the output of `thermite doctor`.
