---
title: "Add a rig on a machine over SSH"
description: "Let control set a rig up on another machine you can reach over SSH."
type: how-to
sidebar:
  order: 2
---

Control can set a [rig](../../reference/glossary.md) up on a Linux machine it reaches over SSH. It reads the machine, installs what is missing if you allow it, writes the rig's services and starts them. Apart from one line in `authorized_keys`, you do nothing on the machine.

You add the machine once under **Settings › Providers**, then add as many rigs there as it has room for under **Rigs › Add a rig**.

:::note[What these rigs don't have yet]
Rigs that control sets up, on a machine, on a cluster or with a join command, get only the few settings listed in [Rigs that control sets up](../../reference/settings.md#rigs-that-control-sets-up). Compared with the local stack, they have:

- **no results repository:** their exports stay in the rig's own volume, so removing the rig deletes them (control keeps the rig's events and its champions' patches). A [full reset](../operate/rig-lifecycle.md#fully-reset-a-rig) stops with "the rig has no results repository", and champions can't be [sent between rigs](../campaigns/several-rigs.md);
- **no advisors file:** advisors come only from [Edit rig](../operate/advisors.md#on-edit-rig);
- **no model prices,** so a contract's money budget (`budget.llm_usd`) counts nothing ([token prices](../campaigns/budget-and-stop-time.md#set-the-token-prices-for-model-spend));
- **no proposer token,** so you can't [submit changes by hand](../campaigns/test-a-kit.md).

[Goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal) lists these gaps.
:::

## Before you start

- **Control is ready for rigs elsewhere:** it has an address the machine can reach (`THERMITE_CONTROL_PUBLIC_URL`) and the rig images (`THERMITE_RIG_HARNESS_IMAGE`, `THERMITE_RIG_SUPERVISOR_IMAGE`, and `THERMITE_RIG_HARNESS_CUDA_IMAGE` for GPUs). See [Let rigs on other machines reach control](one-machine.md#let-rigs-on-other-machines-reach-control).
- **A Linux machine with systemd**, which control reaches over SSH, and which can reach control's address and pull the images. Control can't sign the machine in to a registry: the machine's Podman must pull the images without signing in ([Push the images to your own registry](own-registry.md)).
- **An account on it for control.** Best is an account of its own, made with `sudo useradd -m thermite`. Rigs run as this user's systemd services, under rootless Podman. If the account is `root`, rigs run as system services instead.
- **Sudo without a password** for that account, only if you want control to install what is missing (step 4). Add the line `thermite ALL=(ALL) NOPASSWD: ALL` with `sudo visudo -f /etc/sudoers.d/thermite`. Control uses sudo only to install, so you can remove that file once the installs are done.
- **For GPUs:** NVIDIA GPUs with their driver installed, so that `nvidia-smi` works. Control can install NVIDIA's container toolkit, but not the driver.

## 1. Add the machine

1. Press the cog at the foot of the sidebar to open **Settings › Providers**.
2. Under **Add a provider**, fill in:
   - **Type:** A machine over SSH
   - **Name:** the name Thermite shows for it, such as `gpu-host-1`
   - **Address:** its host name or IP address, as control reaches it
   - **SSH port:** usually 22
   - **User:** the account control logs in as, such as `thermite`
   - **Private key:** paste a private key with no passphrase, or leave it empty and control makes one
3. Press **Add and read its host key**.

The page says `"gpu-host-1" is added. Compare its host key below, then trust it: control connects only after that.` The machine's row opens. If it says that no SSH server answered, check the address and port, then press **Read its host key again**.

## 2. Let control's key in

The machine's row shows a line that starts with `restrict`, followed by the public half of control's key. Select and copy it, then add it to `~/.ssh/authorized_keys` of the user on the machine. For a new account, make the folder and the file first, owned by that user: `~/.ssh` with mode 700 and `authorized_keys` with mode 600. `restrict` turns off forwarding and terminals, which control does not use.

If you left **Private key** empty, control made an ed25519 key, and this step is required. If you pasted your own key and its public half is already in that file, skip it.

## 3. Trust the host key

The row says **Check the host key** and lists one fingerprint for each key the machine presented, with its type (ED25519, ECDSA or RSA). On the machine, print each one's own fingerprint from the matching file and compare:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # and ssh_host_ecdsa_key.pub, ssh_host_rsa_key.pub
```

If they match, press **It matches: trust it**. Control pins the keys: it refuses a machine that later presents another one, and shows you the new key.

Control then logs in and runs a check that only reads. The page says `Trusted "gpu-host-1"'s host key and read the machine: see what it found below.` The row shows:

| Fact | What it tells you |
| --- | --- |
| **System** | The OS, kernel, CPUs, memory and free disk |
| **GPUs** | Each NVIDIA GPU, how busy it is, the driver and the CUDA version |
| **Containers** | Podman's version, and NVIDIA's container toolkit with its CDI spec (the Container Device Interface file that tells Podman which GPUs there are) |
| **Services** | systemd, and whether lingering is on for the user |
| **Rights** | Root, sudo without a password, or no sudo |
| **Reaches control** | Whether the machine reaches control's address |

If the check fails with "the machine refused the key for that user", the key line from step 2 is missing. Add it and press **Check again**.

## 4. Install what is missing

Under **Missing for a rig**, the row lists what the machine still needs, and asks about each one: **May control install Podman?**, followed by the exact script control would run.

- **Install it**: control runs exactly that script, once. Your yes is recorded with your name. The row says **Installing …**; press **refresh** in the status bar (the line along the bottom of the page) to follow it. When it is done, control reads the machine again.
- **Don't install: I'll do it myself**: install it yourself, then press **Check again**.

Control can install three things:

| What | When it is needed |
| --- | --- |
| Podman | Always. Use Podman 4.4 or later: rigs run as Podman Quadlet units |
| NVIDIA's container toolkit (version 1.20.1-1), with a CDI spec | When the machine has GPUs |
| Lingering for the user's services | When the user is not root. Without it the rig stops when the user logs out |

All three need sudo without a password; otherwise the row says "the user can't sudo without a password, so control can't install it". Control installs Podman and the toolkit only on Debian and Ubuntu, and on Fedora, RHEL, CentOS, Rocky Linux, AlmaLinux and Amazon Linux. On another system the row says "control has no recipe for …: install it yourself".

## 5. Add the rig

1. Open **Rigs** in the sidebar, then press **Add a rig**.
2. Under **1 · Where**, choose **gpu-host-1 · a machine over SSH**. A machine that is not ready says why, for example "Not ready: Podman is missing. Fix it under Settings › Providers."
3. Under **2 · GPUs and resources**, tick the GPUs the rig uses. None: the rig measures on the CPU. One: the judge and the agents share it. Several: the lowest-numbered are the judge's, half by default; set **GPUs for the judge** to change that. A GPU another rig uses shows "used by rig …". See [Give a rig several GPUs](several-gpus.md).
4. Under **3 · Name and start**, give a **Rig name**: lowercase letters, digits and dashes. It can't change later. **Images** shows what control will run.
5. Press **Create the rig**.

## 6. Watch it start

You land on the rig's page: "Control is setting rig-1 up on gpu-host-1. Its page fills in once the rig reports for the first time." Its **Set up by control** block lists each step. Press **refresh** to follow:

- ✓ Enrolled with control: a token of its own
- ✓ Files and units written, images ready, services started. The first pull of the images can take a while: control allows 30 minutes for this step.
- ✓ First report reached control. Control waits up to 10 minutes for it.

A step that fails shows ✕ and the reason. When the rig reports, its page fills in: "rig-1 is live; it reported … ago." Over MCP, `rig_setup` shows the rig's status there and the same steps, by their ids. It is for those who run control, so the agent token doesn't have it ([MCP tools](../../reference/mcp-tools.md)).

If the setup step says "rig rig-1 exists on this machine already", an earlier rig of that name left its folder on the machine, and control wrote nothing. Control can't set this rig up again under the same name, so add the rig again under a new name. If you don't need the earlier rig, remove what it left first: on this rig's page, under **Remove it from gpu-host-1**, type `remove rig-1` and press **Remove the rig**. That deletes the earlier rig's units, files and volumes on the machine, with the results in them, and retires this rig. A removed rig's name can't be used again.

### What control writes on the machine

| What | For a user | For root |
| --- | --- | --- |
| The rig's folder: its tokens and control's public key | `~/.local/share/thermite/rigs/rig-1` | `/var/lib/thermite/rigs/rig-1` |
| Four Podman Quadlet files: two containers and two networks | `~/.config/containers/systemd` | `/etc/containers/systemd` |
| Two services | `thermite-rig-1-harness.service` and `thermite-rig-1-supervisor.service`, as the user's services | The same, as system services |
| Five Podman volumes | `thermite-rig-1-state`, `-scratch`, `-inbox`, `-outbox` and `-supervisor` | The same |

## Afterwards

The rig's page keeps the **Set up by control** block: the machine, the GPUs (for example "GPU 0 (judge), GPU 1 (agents)"), the images and the setup history. Its buttons:

- **Stop its services** or **Start its services**, and **Restart them**.
- **Remove it from gpu-host-1**: type `remove rig-1` and press **Remove the rig**. It deletes the rig's units, files and volumes on the machine and retires its token. The rig's results go with its volumes; control keeps only its events, its champions' patches and what its runs added to Thermite's [knowledge base](../../explanation/journals-and-knowledge.md), so [take the result](../campaigns/take-the-result.md) you need first. The page says `Removed from the machine.`, and the rig stays in **Rigs** as not reporting. To take it off the rig lists too, use **Retire it** at the top of its page: type `retire rig-1` and press **Retire it**.

The rig keeps the images it was set up with. When control runs a newer version, the rig's page says so, and **Update to** control's version moves it onto the images control deploys, over SSH: [Update to control's version](../operate/rig-lifecycle.md#update-to-controls-version).

Next, [check the rig](../operate/check-a-rig.md): **Isolation** has already run at start; run **Judge smoke**. Then [give it a model](../models/connect-a-provider.md).

:::caution
Keep the machine in **Settings › Providers** while rigs that control set up there remain. Control needs it to stop, start or remove them, and says "The machine gpu-host-1 is no longer in Providers." without it.
:::
