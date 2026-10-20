---
title: "Add a rig on a Kubernetes cluster"
description: "Let control set a rig up on a Kubernetes cluster, in a namespace it creates or in a slot made for Thermite."
type: how-to
sidebar:
  order: 3
---

Control can set [rigs](../../reference/glossary.md) up on a Kubernetes cluster with a kubeconfig you give it once. Each rig is two pods, its harness and its supervisor, which share one volume on one node. Control applies them, waits for the rig's first report, and later stops, starts and removes it, or moves it onto new images.

Control places each rig in one of two ways:

- **A namespace control creates for each rig**, with the rig's own network rules. The kubeconfig needs rights to create namespaces.
- **Slots**: namespaces the cluster's operators made for Thermite in advance, with their own quotas and network rules. Control only deploys into a free one.

:::note[What these rigs don't have yet]
Rigs that control sets up, on a machine, on a cluster or with a join command, get only the few settings listed in [Rigs that control sets up](../../reference/settings.md#rigs-that-control-sets-up). Compared with the local stack, they have:

- **no results repository:** their exports stay in the rig's own volume, so removing the rig deletes them (control keeps the rig's events and its champions' patches). A [full reset](../operate/rig-lifecycle.md#fully-reset-a-rig) stops with "the rig has no results repository", and champions can't be [sent between rigs](../campaigns/several-rigs.md);
- **no advisors file:** advisors come only from [Edit rig](../operate/advisors.md#on-edit-rig);
- **no model prices,** so a contract's money budget (`budget.llm_usd`) counts nothing ([token prices](../campaigns/budget-and-stop-time.md#set-the-token-prices-for-model-spend));
- **no proposer token,** so you can't [submit changes by hand](../campaigns/test-a-kit.md).

[Goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal) lists these gaps.
:::

## Before you start

- **Control is ready for rigs elsewhere:** its address (`THERMITE_CONTROL_PUBLIC_URL`) and the rig images, plus `THERMITE_RIG_HARNESS_CUDA_IMAGE` for GPU rigs. See [Let rigs on other machines reach control](one-machine.md#let-rigs-on-other-machines-reach-control).
- **The cluster's pods can reach control's address** and pull the images. Control adds no image pull secret, so the nodes must be able to pull the images without one ([Push the images to your own registry](own-registry.md)).
- **A kubeconfig** with everything written inside it: a `token`, or `client-certificate-data` and `client-key-data`, and `certificate-authority-data`. Control refuses a kubeconfig that runs a command to log in (`exec` or an auth-provider), reads files, or goes through a proxy (`proxy-url`).
- **Rights for the kubeconfig:** for namespaces control creates, see [below](#what-created-namespaces-need); for slots, a role in each slot ([below](#what-a-slot-needs)).
- **For GPUs:** NVIDIA's device plugin (`nvidia.com/gpu`), or a device class for DRA (Kubernetes' Dynamic Resource Allocation).

### What created namespaces need

Rights across the cluster, since the namespaces don't exist yet: to create and delete namespaces, and in them to create, change and delete deployments, services, secrets, persistent volume claims and network policies (and resource claim templates for DRA). Control also scales and restarts the deployments to stop, start and restart the rig. To move the rig onto new images, it applies the deployments again. After a start, a restart or a move, it reads the deployments' status (`get`) until the new pods run. With rights to read nodes, storage classes and device classes, its check of the cluster shows them; without them it shows less. Control never reads pods.

Thermite's own cluster test uses the cluster's admin kubeconfig for this placement, so there is no tested narrower role to copy. If the cluster's operators won't give control rights across the cluster, use slots.

### What a slot needs

The cluster's operators make each slot. Thermite's own cluster test gives control a service account in the slot, with these roles:

```sh
kubectl create serviceaccount thermite-control -n thermite-slot-1
kubectl create role thermite-control -n thermite-slot-1 \
  --verb=get,list,watch,create,update,patch,delete \
  --resource=deployments.apps,services,persistentvolumeclaims,secrets,pods,resourceclaimtemplates.resource.k8s.io
kubectl create rolebinding thermite-control -n thermite-slot-1 \
  --role=thermite-control --serviceaccount=thermite-slot-1:thermite-control
kubectl create role thermite-control-read -n thermite-slot-1 \
  --verb=get,list --resource=networkpolicies.networking.k8s.io
kubectl create rolebinding thermite-control-read -n thermite-slot-1 \
  --role=thermite-control-read --serviceaccount=thermite-slot-1:thermite-control
```

For a user rather than a service account, give `--user=<the kubeconfig's user>` to the two `rolebinding` commands. With rights to read the slot's resource quota (add `resourcequotas` to the second role's `--resource`), control also fills in the rig's CPUs, memory and volume from it.

Control writes no network rules in a slot, but it reads them. It refuses a slot unless some network rule selects the rig's harness pods (label `app.kubernetes.io/component: harness`), and every such rule lets them reach only DNS (port 53) or addresses outside the private (RFC 1918) ranges. Thermite's cluster test uses this rule. Its egress part is the same as the rule control writes in a namespace it creates:

```yaml title="thermite-harness-net.yaml"
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: thermite-harness
  namespace: thermite-slot-1
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: harness
  policyTypes: [Egress]
  egress:
    - ports:
        - { port: 53, protocol: UDP }
        - { port: 53, protocol: TCP }
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16]   # the RFC 1918 ranges (public-check: allow)
```

If the slot has other rules, such as one that denies all traffic, they must still let the supervisor pod (label `app.kubernetes.io/component: supervisor`) reach control's address, the internet and the harness on port 8700.

A helper that writes a slot's objects out for the operators is planned ([goal 033](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/033-slot-helper.goal)).

## 1. Add the cluster

1. Press the cog at the foot of the sidebar to open **Settings › Providers**.
2. Under **Add a provider**, fill in:
   - **Type:** A Kubernetes cluster
   - **Name:** the name Thermite shows for it, such as `cluster-1`
   - **Kubeconfig:** paste it
   - **Context:** which context to use. Empty: its current context
   - **Placement:** **A namespace control creates for each rig**, or **Slots the cluster's operators made**
   - **Namespace for each rig** (created namespaces): `thermite-{rig}` by default. `{rig}` becomes the rig's name
   - **Slots** (slots): the slot namespaces, separated by commas, such as `thermite-slot-1, thermite-slot-2`
3. Press **Add and check the cluster**.

Control reads the cluster and changes nothing. The page says `"cluster-1" is added and checked: see what control found below.` The cluster's row shows:

- **Version** and **Nodes**, with each node's GPUs;
- **GPUs**: NVIDIA's device plugin, DRA device classes, or neither;
- **Storage**: the storage classes, with the default one marked;
- **Placement**: "control may create namespaces", or each slot with "free", "used by rig …", "refused: …" or "control may not deploy here".

A refused kubeconfig gives "Not added: …" with the reason.

To change the slots later, edit **Slots** on the cluster's row and press **Save the slots**. Control reads each one again.

## 2. Add the rig

1. Open **Rigs** in the sidebar, then press **Add a rig**.
2. Under **1 · Where**, choose **cluster-1 · Kubernetes**. A cluster that is not ready says why, for example "control may not create namespaces there" or "it has no free slot".
3. Under **2 · GPUs and resources**:
   - **GPUs**: how many the harness pod asks for. **none: the CPU**, one shared by the judge and the agents, or several. With several, **GPUs for the judge** sets the judge's share (half by default). See [Give a rig several GPUs](several-gpus.md).
   - **GPUs through**: **NVIDIA's device plugin**, or **DRA:** and a device class. Where control can't read the cluster's nodes, as is common in a slot, choose **DRA: a device class you name** and name it in **DRA device class**, such as `gpu.nvidia.com`.
   - **Node**: **any node with room**, or one node. A fixed node keeps timings comparable between runs.
   - **Storage class** and **Volume size (GB)**: the rig's one volume, 100 GB by default. It holds the rig's state, builds, inbox and outbox.
   - **CPUs** and **Memory (GiB)**: both or neither. At least 1.5 CPUs and 6 GiB; the supervisor takes half a CPU and 2 GiB of that, the harness the rest. Empty: the namespace's defaults apply.
   - **Slot** (slots): one of the free slots. For created namespaces, **Namespace** shows the pattern control names it by, such as `thermite-{rig}`.
4. Under **3 · Name and start**, give a **Rig name**: lowercase letters, digits and dashes. It can't change later.
5. Press **Create the rig**.

In a slot whose network rules don't keep the harness off the cluster, control refuses with "Refused: in the slot thermite-slot-1, …" and says why. Ask the cluster's operators for a rule like the [example above](#what-a-slot-needs).

## 3. Watch it start

You land on the rig's page: "Control is setting rig-1 up on cluster-1. Its page fills in once the rig reports for the first time." Its **Set up by control** block lists each step. Press **refresh** in the status bar (the line along the bottom of the page) to follow:

- ✓ Enrolled with control: a token of its own
- ✓ Its objects applied in the cluster: namespace, secret, volume, deployments
- ✓ First report reached control

Control waits up to 10 minutes for the first report, and the nodes pull the images in that time. If a large image takes longer, the step shows ✕ "no report after 10 minutes: it may not have started", and the block's status says `failed`. When the rig reports later, its page still fills in, the status says `running` again, and a ✓ step follows the ✕: "A report reached control from the new images · it reported again after the wait ended".

What control applies, all labelled `app.kubernetes.io/instance: rig-1`:

| Object | Name |
| --- | --- |
| Namespace (created namespaces only) | `thermite-rig-1` |
| Secret: the rig's tokens and control's public key | `thermite-rig-1` |
| Persistent volume claim | `thermite-rig-1-data` |
| Service for the harness | `thermite-rig-1-harness` |
| Resource claim template (DRA only) | `thermite-rig-1-gpus` |
| Deployments | `thermite-rig-1-harness` and `thermite-rig-1-supervisor` |
| Network rules (created namespaces only) | `thermite-rig-1-harness-net` and `thermite-rig-1-supervisor-net` |

In a namespace it creates, control's network rules let the harness reach only DNS and addresses outside the private ranges, and let only its supervisor reach the harness.

### If it doesn't report

Look at the rig's pods, with the rig's namespace (in a slot, the slot's):

```sh
kubectl get pods -n thermite-rig-1 -l app.kubernetes.io/instance=rig-1
kubectl describe pods -n thermite-rig-1 -l app.kubernetes.io/instance=rig-1
kubectl logs -n thermite-rig-1 deployment/thermite-rig-1-supervisor
```

| The pods show | Why | Do |
| --- | --- | --- |
| `Pending` | No node has room for the GPUs, CPUs or memory, or the volume claim is not bound. The events at the end of `describe` say which | Free room, or ask the operators. If the rig needs other choices, see below |
| `ErrImagePull` or `ImagePullBackOff` | The nodes can't pull an image | Make the image pullable without signing in: [Push the images to your own registry](own-registry.md) |
| `Running`, and still no report | The supervisor's log says why | [A rig is quiet](../operate/troubleshoot.md#a-rig-is-quiet) |

Once the cause is fixed, the pods start and the rig reports by itself, and its status goes back to `running`. If the rig needs other choices (another storage class, node or number of GPUs), remove it (below) and add a new one under a new name: a removed rig's name can't be used again. New images need no new rig: see [Update the rig's images](#update-the-rigs-images).

## Afterwards

The rig's page keeps the **Set up by control** block: the cluster, the namespace ("made by control" or "a slot"), the GPUs, the storage, the images and each step so far. Its heading shows the rig's status there, such as `running`, `stopped`, `starting`, `updating` or `failed`. Its buttons:

- **Stop its pods** or **Start its pods** (the deployments scale to 0 or 1), and **Restart them**. After a start or a restart, the page says `Started.` or `Restarted.`, and the status says `starting`. As after an update, control waits up to 15 minutes for the pods and then up to 10 minutes for a report. The steps "Its pods run the new images" and "A report reached control from the new images" get a ✓, even when no image changed, and the status says `running`. If a wait runs out, its step gets ✕ and the status says `failed`.
- **Update to these images**, when control deploys other images than the rig runs; **Try the update again**, when the last change to its pods failed; **Give it control's new address**, when only control's address changed. See [Update the rig's images](#update-the-rigs-images).
- **Remove it from cluster-1**: type `remove rig-1` and press **Remove the rig**. Control deletes the namespace it created, or the rig's objects in the slot, and retires the rig's token. The rig's results go with its volume; control keeps only its events and its champions' patches, so [take the result](../campaigns/take-the-result.md) you need first. The page says `Removed from the cluster.`, and the rig stays in **Rigs** as not reporting. To take it off the rig lists too, use **Retire it** at the top of its page: type `retire rig-1` and press **Retire it**.

Control makes one change at a time. While the status says `starting` or `updating`, it refuses a start, a restart or an update, and the page shows a card that starts with **Not done.**, such as `rig-1 is starting: wait until its page shows it running, or failed.` **Stop its pods** and **Remove the rig** are never refused for this.

Next, [check the rig](../operate/check-a-rig.md), then [give it a model](../models/connect-a-provider.md).

## Update the rig's images

After you update Thermite, push the new images and restart control with them ([Push the images to your own registry](own-registry.md)). The rig keeps running its old images until you move it: its **Set up by control** block then says "Control now deploys other images:" and offers **Update to these images**. Control applies the rig's two deployments again with the new images, waits for the new pods and a report from them, and lists each step in the block. The rig's volume, tokens, runs and results stay.

- **Control's address for rigs must be set** (`THERMITE_CONTROL_PUBLIC_URL`). The update writes it into the rig's supervisor again, so a changed address reaches the rig too. Without it, control refuses: `Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.`
- **One change at a time:** wait until the status says `running` or `failed` before you update again.
- **A failed change can be tried again:** while the status says `failed`, the block says "The last change to its pods failed (see the steps above)." and offers **Try the update again**, which applies control's images again and waits once more.
- **When only control's address changed,** the block says "Control's address for rigs changed: …" and offers **Give it control's new address**. A rig set up by an older version of control shows this button only after its next update; until then, use `update_rig_images` over MCP ([below](#from-an-agent-or-a-script)).

For the steps, what changes and what to check afterwards, see [Move a rig onto new images](../operate/rig-lifecycle.md#a-rig-on-a-cluster), [Try again after a failure](../operate/rig-lifecycle.md#try-again-after-a-failure) and [When only control's address changed](../operate/rig-lifecycle.md#when-only-controls-address-changed).

## From an agent or a script

Over MCP, the owner's and the operator's tokens have four tools for clusters (see [MCP tools](../../reference/mcp-tools.md)):

- `add_cluster_rig` adds a rig on a cluster in Providers, with the same checks as **Add a rig**. Its fields are `rig`, `cluster`, `slot`, `gpus`, `judge_gpus`, `gpu_mode` (`device-plugin` or `dra:<device class>`), `node`, `storage_class`, `storage_gb`, `cpus` and `memory_gib`. It answers with the rig's name and `"status": "deploying"`; follow the rig with `rig_setup` and `list_rigs`.
- `set_cluster_slots` replaces the list of slots of a cluster that uses slots. A slot that holds a rig must stay in the list.
- `cluster_rig` stops, starts or restarts a rig, as the buttons on its page do. Its fields are `rig` and `action`: `stop`, `start` or `restart`. Its answer's `said` is `Stopped.`, `Started.` or `Restarted.` After a start or a restart, follow the rig with `rig_setup`: it says `starting`, then `running` once the pods run and the rig reports, or `failed`. Removing a rig is done on the dashboard.
- `update_rig_images` moves a rig onto control's images, as **Update to these images**, **Try the update again** and **Give it control's new address** do. Its one field is `rig`. Its answer's `said` is one of:
  - `rig-1's pods restart on the new images.`;
  - `rig-1 runs the new images when it starts again.` (a stopped rig);
  - `rig-1's pods restart with control's new address.`, when only control's address for rigs changed, and also when it tries a failed change again on the same images;
  - `rig-1 gets control's new address when it starts again.` (a stopped rig);
  - `rig-1 already runs control's images.`: the images and control's address are the same as the rig's, or control couldn't read the rig's supervisor deployment.

  An update while the rig is `updating` or `starting` is refused, and so is one without control's address for rigs, with the same reasons as on the page.

`rig_setup` (field `rig`) shows a rig that control set up: the cluster, the namespace, the placement, the rig's status there, its images, and each step, oldest first. A step is `{at, step, ok, detail}`, with the step's id rather than the page's words, such as `applied`, `first_report`, `images`, `images_running` or `report_after_images`. A failed step has `"ok": false` and the reason in `detail`. Use it to follow a new rig, a start or an update. It is for those who run control: the agent token doesn't have it, and a reader's token gets each step with `detail` set to `null`.

Once the rig shows on **Rigs**, `set_rig_model` gives its agents a model from **Providers**, as **Edit rig** does. Adding the cluster itself is done on the dashboard.
