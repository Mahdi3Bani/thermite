---
title: "Stop, restart, remove or reset a rig"
description: "Stop, start, restart, update, remove, retire, bring back or fully reset a rig, and know what each one keeps."
type: how-to
sidebar:
  order: 5
---

What you can do to a [rig](../../reference/glossary.md), and where, depends on how the rig was set up. This page lists each action for each kind of rig, then gives the steps.

| Action | The local compose stack | Set up by control on a machine | Set up by control on a cluster | Joined yourself |
| --- | --- | --- | --- | --- |
| Stop and start | Your compose tool | **Stop its services**, **Start its services** | **Stop its pods**, **Start its pods** | Commands on its page, which you run there |
| Restart | Your compose tool | **Restart them** | **Restart them** | A command on its page |
| Move to new images | Your compose tool | Not yet | **Update to these images** | Not yet |
| Remove | Your compose tool | **Remove the rig** | **Remove the rig** | A command on its page, then **Retire the rig** |
| Retire, bring back | Yes | Yes | Yes | Yes |
| Full reset | Yes | Not yet | Not yet | Not yet |

A full reset needs a [results repository](results-repository.md). Of the rigs Thermite sets up, only the compose stack has one; control can't give one to the others yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). On them, a full reset fails at its `verifying` step.

The buttons below are on the rig's page: open **Rigs** in the dashboard's sidebar, then the rig.

## Stop and start

**A rig set up by control** has a **Set up by control** block on its page. Press **Stop its services** (a machine) or **Stop its pods** (a cluster). The block shows `stopped`, and the button becomes **Start its services** or **Start its pods**. Its runs stay as they are. After three minutes without a report, the rig shows **Not reporting** until you start it again.

**A rig you joined yourself** has a **You run it yourself** block. Open "Stop, start, restart or remove it: you run these there", and run the **Stop** or **Start** command where the rig runs. Control can't reach that place, so it can't do it for you.

**The compose stack** is stopped and started with your compose tool, for example `docker compose stop supervisor harness` and `docker compose start harness supervisor`.

## Restart

A restart stops and starts the rig's two containers: its harness, which holds the judge and the agents, and its supervisor. It does not export first. Restarting the harness ends its running [trials](../../reference/glossary.md), and its judge jobs start again.

- **Set up by control:** press **Restart them** in the **Set up by control** block. The page says `Restarted.`
- **Joined:** run the **Restart** command from the rig's page, there.
- **The compose stack:** restart its containers with your compose tool, for example `docker compose restart harness supervisor` (`harness-2 supervisor-2` for `local-2`).

### Give control a deployment driver

A deployment driver lets control restart a rig's containers itself: with the **Restart the rig's containers** button in the **⋯** menu of the rig's page, over the REST API, and at the end of a full reset. Without one, the menu says `No deployment driver: restarts are not available.` You don't need one for the steps on this page. It is the setting `THERMITE_LIFECYCLE` on control.

- **`compose`** restarts the compose stack's containers through the container engine's socket. The file `compose.lifecycle.yaml` mounts the socket into control and sets the driver. It is meant for development, because the socket gives control power over every container on the computer. With rootless Podman, give the path that `podman info` prints, without `unix://`:

  ```sh
  podman info --format '{{.Host.RemoteSocket.Path}}'   # prints unix:// and the socket's path
  THERMITE_ENGINE_SOCKET_HOST=/run/user/1000/podman/podman.sock \
    podman compose -f compose.yaml -f compose.lifecycle.yaml up -d
  ```

  On a Mac, the path it prints is inside the Podman machine, where the containers run: use it as it is. With Docker, leave out `THERMITE_ENGINE_SOCKET_HOST`: the file uses `/var/run/docker.sock`. The driver finds each rig's containers by the compose project, `thermite`, and their service names in `THERMITE_COMPOSE_SERVICES`; `compose.yaml` sets both (`THERMITE_COMPOSE_PROJECT` and `THERMITE_COMPOSE_SERVICES`) for `local-1` and `local-2`.

  Use the file from the stack's first start. Added to a stack that has already run, control stops at start, and its log has a `fatal` line with `EPERM: operation not permitted, chmod '/var/lib/thermite-control/control-signing.key'`: with the file, control runs as root, without the right to change the key file that it made as its own user before. Thermite can't add the driver to such a stack yet. Start again without the file, and control comes back as it was.
- **`kubernetes`** is for a control that you run inside a Kubernetes cluster yourself; Thermite ships no manifest for that yet ([goal 058](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/058-helm-and-npm.goal)). Rigs that control sets up on a cluster don't need it: they have **Restart them**. The driver deletes the rig's pods, and their deployments start new ones. Control uses its own service account in the cluster, or the API server, token and CA in `THERMITE_K8S_API`, `THERMITE_K8S_TOKEN_FILE` and `THERMITE_K8S_CA_FILE`. It needs the right to get, list and delete pods in each rig's namespace. `THERMITE_K8S_NAMESPACE` names that namespace, with `{rig}` for the rig's name. Its default is `ar-{rig}`, which is not `thermite-{rig}`, the default name of the namespaces that control creates, so set it to match your rigs' namespaces.

With a driver, you can also restart over the REST API with the owner's token. The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead. The body is optional; without it, both parts restart:

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  -H 'content-type: application/json' -d '{"components":["supervisor"]}' \
  http://127.0.0.1:8800/v1/rigs/local-1/restart
```

It answers `{"restarted":["supervisor"]}`, or `409 {"error":"no deployment driver is configured"}`.

## Move a rig onto new images

A rig keeps the images it was set up with until you move it. What you can do depends on the kind of rig:

- **The compose stack:** rebuild its images and start it again with your compose tool, as [Stop, start and update](../install/one-machine.md#stop-start-and-update) says.
- **Set up by control on a cluster:** control moves it onto the images it now deploys, as below.
- **Set up by control on a machine, or joined yourself:** not yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)). Add a new rig from the new images instead.

### A rig on a cluster

Control moves the rig's two deployments, its harness and its supervisor, onto the images it now deploys. The rig's volume, tokens, runs and results stay.

Before you start:

- **Control runs with the new images,** and was restarted after you set them: `THERMITE_RIG_HARNESS_IMAGE` (`THERMITE_RIG_HARNESS_CUDA_IMAGE` for a rig with GPUs) and `THERMITE_RIG_SUPERVISOR_IMAGE` ([settings](../../reference/settings.md#rigs-that-control-sets-up)). [Push the images to your own registry](../install/own-registry.md) says how. Give each new build a new tag: control compares the images' names, not their contents, and offers the update only when a name differs.
- **Control's address is still set** (`THERMITE_CONTROL_PUBLIC_URL`): the update writes it into the rig's supervisor again.
- **The cluster is still in Settings › Providers.**

Steps:

1. Open **Rigs** and choose the rig. Its **Set up by control** block says "Control now deploys other images:" with the two image names, then:

   > Its pods restart on these images. Its volume, tokens, runs and results stay. A trial in progress stops, and the harness plans it again. After a newer harness has opened its ledger, an older image may not open it.

2. Press **Update to these images**.

   The page says `rig-1's pods restart on the new images.` The block's status, at the right of its heading, says `updating`, and **Images** names the new images. A new step reads "Its deployments applied with new images", with the old and the new name of each image that changed.

3. Wait, then press **refresh** in the status bar, the line along the bottom of the page. Control waits up to 15 minutes for the new pods to run, then up to 10 minutes for a report from them. Two more steps get a ✓, "Its pods run the new images" and "A report reached control from the new images", and the status is `running` again.

If a step gets ✕ instead, with "not running after 15 minutes" or "no report after 10 minutes: it may not have started", the status says `failed`: see [A rig on a cluster never reports](troubleshoot.md#a-rig-on-a-cluster-never-reports). If control refuses the update, the page shows a card that starts with **Not done.** and the reason, such as `The cluster cluster-1 is no longer in Providers.` or kubectl's error.

After the update, run the rig's **Isolation** and **Judge smoke** checks: control doesn't run them for you ([Check a rig](check-a-rig.md)).

What changes and what stays:

| Changes | Stays |
| --- | --- |
| The images of the rig's two deployments | Its secret, so its tokens and control's public key |
| Anything else that control now writes into the deployments, such as the address the supervisor reports to | Its volume, so its [ledger](../../reference/glossary.md) (the rig's record), runs, results and signing key |
| | Its service, its network rules and, with DRA, its resource claim template |
| | Its place: the cluster, the namespace or slot, the node, the GPUs and the storage |

- **A stopped rig stays stopped.** The page says `rig-1 runs the new images when it starts again.`, the step ends with "at its next start", and control waits for nothing. **Start its pods** then starts it on the new images.
- **A trial in progress stops**, as with a restart. When the harness starts again, it closes the trial as interrupted, and the lane goes on with a new one.

:::caution[Going back to older images]
A newer harness may upgrade the rig's ledger when it opens it, and an older harness refuses a ledger that a newer one upgraded. So moving a rig back to older images may leave it unable to start: see [The harness stops at start: the ledger is newer](troubleshoot.md#the-harness-stops-at-start-the-ledger-is-newer). Thermite can't roll a rig back yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).
:::

Over MCP, the owner's and an operator's tokens do the same with `update_rig_images`, and `rig_setup` shows the rig's status and each step: see [From an agent or a script](../install/rig-on-a-cluster.md#from-an-agent-or-a-script). The REST API has no route for it.

## Remove

**Set up by control:** in the **Set up by control** block, open "Remove it from …", type `remove rig-1`, and press **Remove the rig**. On a machine, control stops the services and deletes the rig's units, files and volumes. On a cluster, it deletes the namespace it made, or the rig's objects in its slot. Either way it retires the rig, so its token stops working. **The rig's own results are lost**, because these rigs have no results repository. Control keeps the rig's events and the patches of its published champions: [take the result](../campaigns/take-the-result.md) you need first.

**Joined:** run the **Remove** command from the rig's page, there. Then retire it.

**The compose stack:** `docker compose down` stops it. `docker compose down -v` also deletes its volumes, with control's state and every result not pushed elsewhere.

## Retire and bring back

Retire a rig that is gone. It leaves the rig lists, its campaigns' pages and **Needs you** (on **Overview**, the first page in the sidebar), and control refuses its reports. Its records stay. **Retiring stops nothing on the machine.**

1. On the rig's page, open the **⋯** menu.
2. Under **Retire it**, type `retire rig-1` and press **Retire it**.

The page says `rig-1 is retired.` For a rig whose token is in control's rig tokens file (`THERMITE_CONTROL_RIG_TOKENS_FILE`), such as the compose stack's, it adds "If its token is in control's settings, take it out there too." The rig is listed under **Retired** on **Rigs**.

You can also retire a rig with `thermite rig retire`, `POST /v1/rigs/<rig>/retire`, or the MCP tool `retire_rig` with `confirm: "retire rig-1"`. Only the owner's token can.

To **bring it back**, open its page and press **Bring it back**, or use `POST /v1/rigs/<rig>/bring-back` or the MCP tool `bring_back_rig`. It shows again, and its reports are taken again. **A token control made for it stays ended.** To let such a rig report again, enroll it again with `thermite rig add`, which also brings it back, and give the rig the new token. See [Make and change tokens](tokens.md).

## Fully reset a rig

A full reset gives a rig a clean start: it exports everything, checks that the export reached the results repository, and wipes the rig's state only after you confirm.

### Before you start

- The rig has a results repository. The compose stack does.
- No commands wait for the rig. A pending command holds the reset at its `quiescing` step. [Cancel](cancel-a-command.md) those you don't need.
- During the reset, `issue_command` refuses an agent's token for the rig, with `rig-1 is being reset by the owner`.

### Steps

1. On the rig's page, open the **⋯** menu. Under **Full reset**, type `reset rig-1` and press **Start the full reset**.

   You land on **Reports**, a page in the sidebar. The **Full resets** table shows the rig and its state. Press **refresh** in the status bar, the line along the bottom of the page, to follow it.

2. Control goes through these states. Each must finish within its time limit, or the reset fails:

   | State | What happens | Limit |
   | --- | --- | --- |
   | `start` | Control pauses the rig's running runs, with the reason "full reset" | |
   | `quiescing` | Control waits until no judge job is queued or running, and no command waits for the rig | 1 hour |
   | `exporting` | The rig takes a full export: what is new since its last export, plus its research archive and a copy of its ledger | 30 minutes |
   | `verifying` | Control waits until the supervisor reports that export pushed to the results repository | 1 hour |
   | `awaiting_owner` | Control waits for you | 24 hours |
   | `confirmed` | You confirmed; control sends the wipe | |
   | `wiping` | After you confirm, the rig checks the export again and wipes its state. Its harness and supervisor start again, and control restarts their containers if it has a deployment driver | 30 minutes |
   | `done` | The **Detail** says `wiped; restarted …`, or `wiped; the rig restarted itself (no deployment driver configured)` | |

3. At `awaiting_owner`, the **Detail** says `export <name> reported pushed (results repository commit <commit>); check it there, then confirm the wipe`. Check that commit in the results repository. On the compose stack:

   ```sh
   docker compose exec supervisor git -C /results/results.git log -1 --oneline refs/heads/thermite/local-1/attempts
   ```

   It prints the start of the commit and its message, `local-1: export <name>, …`. Both must match the **Detail**.

4. Press **Confirm the wipe**, on **Reports** or in the **Wipe** item of **Needs you**. To stop instead, press **Cancel** on **Reports** or **Cancel the reset** in **Needs you**. You can cancel until the wipe starts.

5. When the reset is `done`, the rig starts again with an empty ledger. Its old runs no longer show on its page or on the leaderboard: they are in the results repository. Start new campaigns on it as usual, and check **Edit rig**: the choices made there are wiped, and the rig is back to its defaults.

If the reset fails or is cancelled, nothing is wiped and the runs stay paused. The **Detail** says why, for example `the rig has no results repository: its export cannot be verified` or `timed out while quiescing`.

Over the REST API, with the owner's token: `POST /v1/rigs/<rig>/reset` with `{"confirm":"reset <rig>"}` starts a reset and answers `{"reset":<id>}`. `GET /v1/resets` lists them, and `POST /v1/resets/<id>/confirm` or `/cancel` confirms or cancels one. There is no MCP tool for resets.

### What a full reset keeps

| Wiped | Kept |
| --- | --- |
| The harness's state: its ledger, git mirrors, kits, imports, models, builds, research archive and research folders, the **Edit rig** settings and the model route it was handed | The rig's signing key, so control still trusts it (no key to accept) |
| Its scratch space and outbox | Everything in the results repository, with the full export |
| The supervisor's state: its copy of the results, its fetch caches, its known hosts for Git access, its advisors' records and the day's spending | Control's records: the rig's past events, its commands, champion patches and daily reports. The dashboard shows only what the rig records after the reset |
| | Files outside the rig's state: the advisors file, its tokens, and its environment settings |

After the wipe, the rig refuses commands issued before it. Its model route comes back from control within about half a minute.
