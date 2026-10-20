---
title: "Stop, restart, remove or reset a rig"
description: "Stop, start, restart, update, remove, retire, bring back or fully reset a rig, and know what each one keeps."
type: how-to
sidebar:
  order: 6
---

What you can do to a [rig](../../reference/glossary.md), and where, depends on how the rig was set up. This page lists each action for each kind of rig, then gives the steps.

| Action | The local compose stack | Set up by control on a machine | Set up by control on a cluster | Joined yourself | Launched on RunPod |
| --- | --- | --- | --- | --- | --- |
| Stop and start | Your compose tool | **Stop its services**, **Start its services** | **Stop its pods**, **Start its pods**, or MCP's `cluster_rig` | Commands on its page, which you run there | `thermite runpod stop`, `start`, or MCP's `runpod_rig` |
| Restart | Your compose tool | **Restart them** | **Restart them**, or MCP's `cluster_rig` | A command on its page | `thermite runpod restart`, or MCP's `runpod_rig` |
| Move to new images | Your compose tool | Not yet | **Update to these images** | Not yet | Not yet: launch a new rig |
| Remove | Your compose tool | **Remove the rig** | **Remove the rig** | A command on its page, then **Retire the rig** | `thermite runpod terminate`, which also retires it |
| Retire, bring back | Yes | Yes | Yes | Yes | Yes |
| Full reset | Yes | Yes | Yes | Yes | Yes, with the pod running; the pod and its GPU stay |

A full reset needs the rig's full export off the rig first: in its [results repository](results-repository.md), or, for a rig without one, on control. Of the rigs Thermite sets up, only the compose stack has a results repository; the others send their exports to control ([Exports](../../reference/exports.md#where-exports-go)).

A rig launched on RunPod has no buttons for these on the dashboard yet: [Run a rig on RunPod](../install/runpod-rig.md#5-stop-and-start-it) gives the commands, which the REST API and MCP have too. Its stop sends its results out before the pod stops, and its terminate removes the pod only once every result has left it. A full reset of it starts from its page's **⋯** menu, as below, or with `thermite runpod reset`.

The buttons below are on the rig's page: open **Rigs** in the dashboard's sidebar, then the rig.

## Stop and start

**A rig set up by control** has a **Set up by control** block on its page. Press **Stop its services** (a machine) or **Stop its pods** (a cluster). The block shows `stopped`, and the button becomes **Start its services** or **Start its pods**. Its runs keep their status and their records. A stop ends the trials at work, as a [restart](#restart) does: when the rig starts again, the harness closes them as interrupted, their experiments go back to the top of the queue, and the judge's jobs start again. After three minutes without a report, the rig shows **Not reporting** until you start it again.

**On a cluster, a start takes a few minutes.** After **Start its pods**, the page says `Started.`, and the block's status, at the right of its heading, says `starting`. Control waits up to 15 minutes for the rig's pods to run, then up to 10 minutes for a report from the rig. Press **refresh** in the status bar, the line along the bottom of the page, to follow it:

- Two steps get a ✓, "Its pods run again" and "A report reached control after the start", and the status says `running`.
- If a step gets ✕ instead, the status says `failed`: see [A rig on a cluster never reports](troubleshoot.md#a-rig-on-a-cluster-never-reports). When the rig reports later, its status says `running`, and a ✓ step follows the ✕: "A report reached control after the start · it reported after the wait ended". The block also offers **Try the update again** while the status says `failed`, after a start too: it applies the same images again and waits once more. See [Try again after a failure](#try-again-after-a-failure).

**One change at a time on a cluster.** While the status says `starting` or `updating`, control refuses a start, a restart and an image update. The page shows a card that starts with **Not done.** and the reason, such as `rig-1 is starting: wait until its page shows it running, or failed.` **Stop its pods** and **Remove the rig** are never refused for this. They also end control's wait for the pods and the report, so a rig you stopped or removed during a start or an update doesn't turn `failed` later.

**A rig you joined yourself** has a **You run it yourself** block. Open "Stop, start, restart or remove it: you run these there", and run the **Stop** or **Start** command where the rig runs. Control can't reach that place, so it can't do it for you.

**The compose stack** is stopped and started with your compose tool, for example `docker compose stop supervisor harness` and `docker compose start harness supervisor`.

## Restart

A restart stops and starts the rig's two containers: its harness, which holds the judge and the agents, and its supervisor. It does not export first. Restarting the harness ends its running [trials](../../reference/glossary.md), and its judge jobs start again.

- **Set up by control:** press **Restart them** in the **Set up by control** block. The page says `Restarted.` On a cluster, the status then says `starting` until the pods run and the rig reports, as after **Start its pods**.
- **Joined:** run the **Restart** command from the rig's page, there.
- **The compose stack:** restart its containers with your compose tool, for example `docker compose restart harness supervisor` (`harness-2 supervisor-2` for `local-2`).

### Give control a deployment driver

You don't need a deployment driver for the steps on this page. With one, control also restarts a rig's containers itself: with **Restart the rig's containers** in the **⋯** menu of the rig's page, over the REST API, and at the end of a full reset. A rig launched on RunPod needs none: over the REST API its restart goes to RunPod, which stops its pod and starts it again, and a full reset leaves its pod running. Without one, the menu says `No deployment driver: restarts are not available.` The setting is `THERMITE_LIFECYCLE` on control: `compose` or `kubernetes` (the [settings reference](../../reference/settings.md#restarts-and-full-resets) has the others).

On the compose stack, the file `compose.lifecycle.yaml` sets `compose` and mounts the container engine's socket into control. It is meant for development, because the socket gives control power over every container on the computer. With Docker, add it to your `-f` options. With rootless Podman, also give the socket's path, as `podman info --format '{{.Host.RemoteSocket.Path}}'` prints it, without `unix://` (on a Mac, use the path as it is):

```sh
THERMITE_ENGINE_SOCKET_HOST=/run/user/1000/podman/podman.sock \
  podman compose -f compose.yaml -f compose.lifecycle.yaml up -d
```

Use the file from the stack's first start. Added to a stack that has already run, control stops at start, with `EPERM` on `control-signing.key` in its log ([Troubleshoot](troubleshoot.md#control-stops-at-start-eperm-on-control-signingkey)). Thermite can't add the driver to such a stack yet. Start again without the file, and control comes back as it was.

The `kubernetes` driver is for a control that you run inside a cluster yourself; Thermite ships no manifest for that yet ([goal 058](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/058-helm-and-npm.goal)). Rigs that control sets up on a cluster don't need it: they have **Restart them**.

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
- **Control's address for rigs is set** (`THERMITE_CONTROL_PUBLIC_URL`): the update writes it into the rig's supervisor again. Without it, control refuses the update with `Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.`
- **The cluster is still in Settings › Providers.**
- **The rig is not starting or being updated.** Its status says `running`, `stopped` or `failed`.

Steps:

1. Open **Rigs** and choose the rig. Its **Set up by control** block says "Control now deploys other images:" with the two image names, then:

   > Its pods restart on these images. Its volume, tokens, runs and results stay. A trial in progress stops, and the harness plans it again. After a newer harness has opened its ledger, an older image may not open it.

2. Press **Update to these images**.

   The page says `rig-1's pods restart on the new images.` The block's status, at the right of its heading, says `updating`, and **Images** names the new images. A new step reads "Its deployments applied with new images", with the old and the new name of each image that changed.

3. Wait, then press **refresh** in the status bar, the line along the bottom of the page. Control waits up to 15 minutes for the new pods to run, then up to 10 minutes for a report from them. Two more steps get a ✓, "Its pods run the new images" and "A report reached control from the new images", and the status is `running` again.

If control refuses the update, the page shows a card that starts with **Not done.** and the reason, such as `The cluster cluster-1 is no longer in Providers.`, `rig-1 is being updated: wait until its page shows it running, or failed.`, the refusal for a missing address above, or kubectl's error.

If a step gets ✕ instead, with "not running after 15 minutes" or "no report after 10 minutes: it may not have started", the status says `failed`: see [A rig on a cluster never reports](troubleshoot.md#a-rig-on-a-cluster-never-reports). Fix the cause; the pods keep trying by themselves. When the rig reports again, its status says `running`, and a ✓ step follows the ✕: "A report reached control from the new images · it reported after the wait ended". To have control apply the images again and wait once more, see [Try again after a failure](#try-again-after-a-failure).

After the update, run the rig's **Isolation** and **Judge smoke** checks: control doesn't run them for you ([Check a rig](check-a-rig.md)).

What changes and what stays:

| Changes | Stays |
| --- | --- |
| The images of the rig's two deployments | Its secret, so its tokens and control's public key |
| Anything else that control now writes into the deployments, such as the address the supervisor reports to | Its volume, so its [ledger](../../reference/glossary.md) (the rig's record), runs, results and signing key |
| | Its service, its network rules and, with DRA, its resource claim template |
| | Its place: the cluster, the namespace or slot, the node, the GPUs and the storage |

- **A stopped rig stays stopped.** The page says `rig-1 runs the new images when it starts again.`, the step ends with "at its next start", and control waits for nothing. **Start its pods** then starts it on the new images: the status says `starting`, then `running` once the pods run and the rig reports.
- **A trial in progress stops**, as with a restart. When the harness starts again, it closes the trial as interrupted, and the lane goes on with a new one. The trial's experiment goes back to the top of the run's [experiment queue](../campaigns/choose-what-runs-next.md).

:::caution[Going back to older images]
Thermite has no rollback ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)). To go back, set control's image settings to the old images, restart control, and press **Update to these images**. This works when the new harness never opened the rig's ledger, for example when the new pods never ran. A newer harness that ran may have upgraded the ledger, and an older harness refuses such a ledger before it changes anything: it stops at start, as [The harness stops at start: the ledger is newer](troubleshoot.md#the-harness-stops-at-start-the-ledger-is-newer) says. Nothing is lost then: move the rig onto the newer images again.
:::

Over MCP, the owner's and an operator's tokens do the same with `update_rig_images`. They stop, start and restart the rig with `cluster_rig`, for example `{"rig": "rig-1", "action": "start"}`; it has no `remove`. `rig_setup` shows the rig's status and each step: see [From an agent or a script](../install/rig-on-a-cluster.md#from-an-agent-or-a-script). The REST API has no route for these.

### Try again after a failure

When a change to the rig's pods failed, its status says `failed`. This happens after a new rig's first wait, a start, a restart or an update. When the rig already has control's images, the block offers to apply them again; when control deploys other images, it offers **Update to these images** instead.

1. Fix the cause first: see [A rig on a cluster never reports](troubleshoot.md#a-rig-on-a-cluster-never-reports).
2. On the rig's page, the block says "The last change to its pods failed (see the steps above). Try it again on control's images:", with the two image names. Press **Try the update again**.

   Control applies the rig's two deployments again, as for an update. The page says `rig-1's pods restart on control's images again (a retry).` The status says `updating`, and a new step reads "Its deployments applied with new images", with the detail `the same images again, after a failed change`.
3. Wait, then press **refresh**. As after an update, the status says `running` once the pods run and the rig reports, or `failed` again with the step that failed.

Over MCP, `update_rig_images` does the same for a rig whose status is `failed`, with the same answer.

### When only control's address changed

When you move control to a new address, set `THERMITE_CONTROL_PUBLIC_URL` to it and restart control. A rig keeps reporting to the old address until its supervisor gets the new one. When control's images changed too, **Update to these images** gives the rig the new address as well. When only the address changed:

1. Open the rig's page. Its **Set up by control** block says "Control's address for rigs changed: the rig reports to `https://control-old.example.com`, control is now at `https://control.example.com`."
2. Press **Give it control's new address**. The rig's pods restart with the new address, on the same images. Its volume, tokens, runs and results stay; a trial in progress stops.

   The page says `rig-1's pods restart with control's new address.`, and the status says `updating`. Control waits for the pods and a report, as after an update. For a stopped rig, the page says `rig-1 gets control's new address when it starts again.` The new step "Its deployments applied with new images" has the detail `control's address for rigs →` and the new address.

Before it restarts anything, control reads the address in the rig's supervisor deployment. When it is already the new one, the answer is `rig-1 already runs control's images.` and nothing changes. When control can't read the deployment, it refuses with `Control could not read rig-1's deployment to compare control's address:` and kubectl's error: check that the cluster is reachable and that the deployment is still there.

Control records the address it gives each rig. A rig set up by a control too old to record it shows no button. On the dashboard, it gets the new address with its next **Update to these images**. To give it the address now, call `update_rig_images` over MCP: control reads the deployment in the same way and applies it again with the new address.

## Remove

**Set up by control:** removing the rig deletes everything on it. These rigs have no results repository: they send their exports to control, which keeps them with the rig's events and the patch of each champion the rig has exported. So, before you remove it:

1. On the rig's page, press **Export now**, and wait a minute or two: the rig sends that export, and its champions' patches, to control.
2. Check that every result has left the rig: see [Get a rig's results from control](exports-on-control.md#4-check-that-every-result-has-left-the-rig).

Then, in the **Set up by control** block, open "Remove it from …", type `remove rig-1`, and press **Remove the rig**. On a machine, control stops the services and deletes the rig's units, files and volumes. On a cluster, it deletes the namespace it made, or the rig's objects in its slot. Either way it retires the rig, so its token stops working.

**Joined:** run the **Remove** command from the rig's page, there. Then retire it.

**The compose stack:** `docker compose down` stops it. `docker compose down -v` also deletes its volumes, with control's state and every result not pushed elsewhere.

## Retire and bring back

Retire a rig that is gone. It leaves the rig lists, its campaigns' pages and **Needs you** (on **Overview**, the first page in the sidebar), and control refuses its reports. Its records stay. **Retiring stops nothing on the machine.**

1. On the rig's page, open the **⋯** menu.
2. Under **Retire it**, type `retire rig-1` and press **Retire it**.

The page says `rig-1 is retired.` The rig is listed under **Retired** on **Rigs**. A token control made for the rig, with **Add a rig**, a join command or `thermite rig add`, stops working.

A rig whose token is in control's rig tokens file (`THERMITE_CONTROL_RIG_TOKENS_FILE`), such as the compose stack's `local-1` and `local-2`, keeps its token: the page adds "If its token is in control's settings, take it out there too." Do so only to end the rig for good: take its line out of that file (`.dev/secrets/control-rig-tokens.json` on the local stack) and restart control. Leave it in if you may bring the rig back.

You can also retire a rig with `thermite rig retire`, `POST /v1/rigs/<rig>/retire`, or the MCP tool `retire_rig` with `confirm: "retire rig-1"`. Only the owner's token can.

To **bring it back**, open its page and press **Bring it back**, or use `POST /v1/rigs/<rig>/bring-back` or the MCP tool `bring_back_rig`. It shows again, and its reports are taken again:

- A rig with its token still in the rig tokens file reports again at once.
- **A token control made for it stays ended.** To let such a rig report again, enroll it again with `thermite rig add`, which also brings it back, and give the rig the new token. See [Make and change tokens](tokens.md).

## Fully reset a rig

A full reset gives a rig a clean start: it exports everything, checks that the export left the rig, and wipes the rig's state only after you confirm.

### Before you start

- The rig's exports leave it: to its results repository (the compose stack has one), or to control (every other rig). See [Exports](../../reference/exports.md#where-exports-go).
- No commands wait for the rig. A pending command holds the reset at its `quiescing` step. [Cancel](cancel-a-command.md) those you don't need.
- During the reset, `issue_command` refuses an agent's token for the rig, with `rig-1 is being reset by the owner`.
- A rig launched on RunPod: its pod runs, and no stop, start, restart or terminate is under way. Otherwise the reset fails at once, for example with `rp-1a2b3c4d's pod is stopped: start it first, so its results can leave it before the wipe`. Its reset also waits until no other export or champion's patch waits on the pod, and its pod and GPU stay: the harness and the supervisor restart themselves in it.

### Steps

1. On the rig's page, open the **⋯** menu. Under **Full reset**, type `reset rig-1` and press **Start the full reset**.

   You land on **Reports**, a page in the sidebar. The **Full resets** table shows the rig and its state. Press **refresh** in the status bar, the line along the bottom of the page, to follow it.

2. Control goes through these states. Each must finish within its time limit, or the reset fails:

   | State | What happens | Limit |
   | --- | --- | --- |
   | `start` | Control pauses the rig's running runs, with the reason "full reset" | |
   | `quiescing` | Control waits until no judge job is queued or running, and no command waits for the rig | 1 hour |
   | `exporting` | The rig takes a full export: what is new since its last export, plus its research archive and a copy of its ledger | 30 minutes |
   | `verifying` | Control waits until the supervisor reports that export pushed to the results repository, or, for a rig without one, until control holds every file of it | 1 hour |
   | `awaiting_owner` | Control waits for you | 24 hours |
   | `confirmed` | You confirmed; control sends the wipe | |
   | `wiping` | After you confirm, the rig checks the export again and wipes its state. Its harness and supervisor start again, and control restarts their containers if it has a deployment driver | 30 minutes |
   | `done` | The **Detail** says `wiped; restarted …`, or `wiped; the rig restarted itself (no deployment driver configured)` | |

3. At `awaiting_owner`, the **Detail** says `export <name> reported pushed (results repository commit <commit>); check it there, then confirm the wipe`. Check that commit in the results repository. On the compose stack:

   ```sh
   docker compose exec supervisor git -C /results/results.git log -1 --oneline refs/heads/thermite/local-1/attempts
   ```

   It prints the start of the commit and its message, `local-1: export <name>, …`. Both must match the **Detail**.

   For a rig that sends its exports to control, the **Detail** says `export <name> is on control, every file checked against its manifest; check it there (GET /v1/rigs/<rig>/exports/<name>), then confirm the wipe`. Read that export's listing, as in [Get a rig's results from control](exports-on-control.md#3-download-an-exports-files): its `complete_at` is set, and `full` is `true`.

4. Press **Confirm the wipe**, on **Reports** or in the **Wipe** item of **Needs you**. To stop instead, press **Cancel** on **Reports** or **Cancel the reset** in **Needs you**. You can cancel until the wipe starts.

5. When the reset is `done`, the rig starts again with an empty ledger. Its old runs no longer show on its page or on the leaderboard: they are in the results repository, or on control. Start new campaigns on it as usual, and check **Edit rig**: the choices made there are wiped, and the rig is back to its defaults.

If the reset fails or is cancelled, nothing is wiped and the runs stay paused. The **Detail** says why, for example `the rig has no results repository, and its supervisor does not send exports to control (an older version): its export cannot be verified` or `timed out while quiescing`.

Over the REST API, with the owner's token: `POST /v1/rigs/<rig>/reset` with `{"confirm":"reset <rig>"}` starts a reset and answers `{"reset":<id>}`. `GET /v1/resets` lists them, and `POST /v1/resets/<id>/confirm` or `/cancel` confirms or cancels one. For a rig launched on RunPod, the owner's MCP tool `runpod_rig` (`reset`, `confirm_wipe`, `cancel_reset`) and `thermite runpod reset`, `confirm-wipe` and `cancel-reset` do the same. There is no MCP tool for other rigs' resets.

### What a full reset keeps

| Wiped | Kept |
| --- | --- |
| The harness's state: its ledger, git mirrors, kits, imports, models, builds, research archive and research folders with their copies of past research (`knowledge/`), the **Edit rig** settings and the model route it was handed | The rig's signing key, so control still trusts it (no key to accept) |
| Its scratch space and outbox | Everything in the results repository or on control, with the full export |
| The supervisor's state: its copy of the results, its fetch caches, its known hosts for Git access, its advisors' records, the day's spending and where each run's past research sync had got to | Control's records: the rig's past events, its commands, champion patches and daily reports. The dashboard shows only what the rig records after the reset |
| | Control's [knowledge base](../../reference/knowledge-base.md): the items of the rig's earlier runs stay in their campaigns' folders |
| | Files outside the rig's state: the advisors file, its tokens, and its environment settings |

After the wipe, the rig refuses commands issued before it. Its model route comes back from control within about half a minute.
