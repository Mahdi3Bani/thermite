---
title: "Compatibility"
description: "The Node.js versions, operating systems, container engines, compose tools, Kubernetes, GPUs, CUDA and CPU architectures Thermite works with, and how each is tested."
type: reference
sidebar:
  order: 15
---

This page lists what Thermite needs and what it has been tested with. Each row says how it is tested, or **not tested** where nothing in the repository tests it. A version Thermite does not check is marked so: it may work, but nothing shows it. The [glossary](glossary.md) explains the terms.

## Node.js

| Where | Version | How it is tested |
| --- | --- | --- |
| Your computer, for the `thermite` command, the tests and the scripts | 22.19 or later (`engines` in `package.json`). The agent libraries need it | CI runs the type check, lint and tests on Node.js 22 and 24 |
| Inside the images | The Node.js 22 of `node:22-bookworm-slim`, pinned by digest. The exact 22.x release is whatever that digest holds | Every image build |

The images build their own copy of Thermite, so the compose stack needs Node.js on your computer only for `npm run dev:init`, the command line and the test scripts.

## Operating systems

| System | Status | How it is tested |
| --- | --- | --- |
| Linux | Supported | CI runs on Ubuntu 24.04 |
| macOS | Supported, with Podman or Docker running their Linux virtual machine | Not in CI. The compose test scripts work with a Podman machine: they trim its disk after each run |
| Windows | Not tested | Nothing in the repository tests it |

### Machines that host rigs

A machine that control sets rigs up on, over SSH or with a join command, needs Linux with systemd and Podman. A rig that runs as a user other than root needs lingering on for that user.

| Machine's system | What control can install for you | How it is tested |
| --- | --- | --- |
| Debian, Ubuntu | Podman (apt), NVIDIA's container toolkit, lingering | Machines acceptance: control installs Podman on a Debian 12 container that stands in for the machine |
| Fedora, RHEL, CentOS, Rocky Linux, AlmaLinux, Amazon Linux | Podman (dnf), NVIDIA's container toolkit, lingering | Rig deploy acceptance: control turns lingering on and sets a CPU rig up on a Fedora 41 container with systemd and rootless Podman. The dnf installs are not tested |
| Any other Linux | Lingering only. Install the rest yourself: control says `control has no recipe for <os>: install it yourself` | Not tested |

Installs need `sudo` without a password. See [Add a rig on a machine over SSH](../how-to/install/rig-on-a-machine.md).

## Container engines and compose tools

| Tool | Status | How it is tested |
| --- | --- | --- |
| Docker with `docker compose` | Supported | CI runs the compose smoke test with it |
| Podman with `podman compose` | Supported | Every compose acceptance script takes it, and it is their default. Not in CI |
| podman-compose | Supported | The compose smoke test takes it (`COMPOSE="podman-compose"`). Not in CI |
| Podman on a machine that hosts rigs | 4.4 or later, for its Quadlet units | The rig deploy acceptance, on Fedora 41's Podman. Neither the join script nor setting up over SSH checks the version: the join script checks only that Podman is there |

No minimum version of Docker, Docker Compose, Podman or podman-compose is stated or checked for the compose stack. `compose.yaml` uses secrets from files, profiles, internal networks, `extra_hosts` with `host-gateway`, dropped and added capabilities, `no-new-privileges`, restart policies and `${VAR:-default}` defaults.

Two acceptance tests need Podman and refuse Docker: rig deploy and cluster. [Install Thermite on one machine](../how-to/install/one-machine.md) gives the commands for each tool.

## Kubernetes

| Point | Status | How it is tested |
| --- | --- | --- |
| Kubernetes version | No minimum is stated. Control's image carries `kubectl` v1.37.1 | A kind cluster on Podman (cluster acceptance), with kind's default node image. The kind version is not pinned |
| APIs used | `v1`, `apps/v1`, `networking.k8s.io/v1`; `resource.k8s.io/v1` for GPUs through dynamic resource allocation | |
| Placements | `created` (control makes the namespace), `slot` (a namespace made for Thermite), `joined` (a namespace join command) | Cluster acceptance tests `created` and `slot`, with CPU rigs only. In the slot it also moves the rig onto newly tagged images (**Update to these images**), and checks that the rig reports again with its volume claim and secret unchanged |
| GPUs through the device plugin (`nvidia.com/gpu`) | Control can set a rig up this way | Not tested |
| GPUs through dynamic resource allocation (a device class) | Control can set a rig up this way | Not tested |
| NetworkPolicy | Control writes them for `created` and `joined` placements, and checks a slot's rules before it uses the slot. They need a network plugin that enforces them | Cluster acceptance: a created namespace gets its policies, and a slot without the needed rule is refused |
| Running control itself on Kubernetes | No manifest or chart ships. [Goal 058](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/058-helm-and-npm.goal) plans one | Not tested |

See [Add a rig on a Kubernetes cluster](../how-to/install/rig-on-a-cluster.md).

## GPUs, CUDA and drivers

| Point | Status | How it is tested |
| --- | --- | --- |
| GPU vendor | NVIDIA only: `nvidia-smi`, `/dev/nvidia*` device nodes, CDI on machines, the device plugin or dynamic resource allocation on clusters | |
| GPUs on one rig | Up to 8 for the judge and 8 for the agents. Up to 16 on a rig control sets up on a machine or cluster; 8 on a joined namespace | The multi-GPU acceptance, with four fake GPUs (plain files and a stand-in `nvidia-smi`) |
| Several judge GPUs | They must be the same model. Otherwise only the first one judges, and the rig's hardware report says why | Not tested |
| CUDA | A CUDA 12.x development image as the harness's base. The repository names no exact image. CUDA 13 dropped older architectures. RunPod test pods ask for hosts with CUDA 12.6 or later | No test in the repository. A RunPod test pod checks one real GPU host: see [Test a GPU on RunPod](../how-to/install/runpod-test.md) |
| GPU architecture of the CUDA smoke kit | Built for `sm_60` | |
| NVIDIA driver | No minimum is stated or checked. A machine's check reports the driver and CUDA versions | Not tested |
| NVIDIA container toolkit | 1.20.1-1 when control installs it, with a CDI specification for Podman | Not tested: the machines acceptance installs only Podman |
| Landlock (Linux kernel) | Used for the GPU fence when the kernel has it | Multi-GPU acceptance; the RunPod test's probe |
| GPU rigs under compose | Not available. [Goal 037](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/037-gpu-compose.goal) plans them | |

Without Landlock, and with device nodes that cannot be given their own groups, a GPU rig neither times nor allows development runs; it never falls back to sharing. [Sharing a device](../explanation/sharing-a-device.md) explains why, and [Give a rig several GPUs](../how-to/install/several-gpus.md) shows how to set the split.

## CPU architectures

| Image | Architectures | How it is tested |
| --- | --- | --- |
| Control | amd64 and arm64. Its build stops on any other: `kubectl` is pinned for these two only | CI builds it on amd64 (GitHub's `ubuntu-24.04` runners) |
| Harness | amd64 and arm64. It installs the arm64 package of OpenCode and Claude Code on arm64, and the x64 package on any other architecture | CI builds it on amd64 |
| Supervisor | Not stated. Claude Code, when built in, comes as its arm64 or x64 package | CI builds it on amd64 |

No test in the repository builds the images for more than one architecture. [Push the images to your own registry](../how-to/install/own-registry.md) builds them yourself, and [Harness image](harness-image.md) lists what each contains.

## Control and rig versions

Control and its rigs do not compare their versions. Control can move a rig it set up on a cluster onto the images it now deploys (**Update to these images** on the rig's page); rigs on machines and joined rigs keep their images ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).

| Case | What happens | How it is tested |
| --- | --- | --- |
| A rig's harness is older than control | It refuses a command kind it does not have with `malformed command`, and a payload its own schema does not allow with `bad payload: …`. A harness from before messages could be kept in force refuses `unkeep_message` and a `message_agent` to `all`, `teachers`, `auditor` or `panel`, and drops `keep` from other messages, which then are not kept in force; a run's **Live** shows its message lines and reads as plain lines, since it draws **To …** and **✓ … read your message** only from the run's `agent_message` events. A harness from before the experiment queue refuses `queue_add`, `queue_move`, `queue_edit`, `queue_drop`, `queue_accept` and `drop_directive` with `malformed command`, refuses a rule in your own words with `bad payload: directives.<i>: Unrecognized key: "match"`, and starts a run with an empty queue whatever `assign_campaign`'s `queue` holds | Not tested |
| A harness opens a ledger an older harness wrote | It upgrades the ledger | The harness's tests |
| A harness opens a ledger a newer harness upgraded | It refuses the ledger, and the harness does not start: `this ledger is at schema version <n>, newer than this code's <m>: run a newer Thermite, or restore the ledger from before the upgrade`. A rig moved back onto an older image can hit this | The harness's tests |

## What is not known

- The oldest Docker, Docker Compose, Podman or podman-compose that runs the compose stack.
- The oldest Kubernetes that runs a rig, and whether GPU rigs work on a real cluster.
- The oldest NVIDIA driver that works.
- Windows, and arm64 images.
- How much memory and disk the stack needs. Lane build caches can reach 8 GB each. A cluster rig with resources set needs at least 1.5 CPUs and 6 GiB of memory.
