---
title: "Extend the harness image"
description: "Add the compilers and tools your project needs to the image the agents and the judge run in."
type: how-to
sidebar:
  order: 7
---

The harness image is where your project is built, timed and changed: the judge's builds and timed runs and the agents' commands all run inside it. If your project needs a tool the image lacks, such as another compiler or a library, build your own image `FROM` Thermite's harness image and add it.

The image already has a C and C++ toolchain (`gcc`, `g++`, `make`), CMake, Ninja, ccache, Python 3 with numpy, git, Node.js and OpenCode. A CUDA image also has what its base carries, such as `nvcc`. The CPU image is Debian bookworm; a CUDA image has its base's system. The [harness image reference](../../reference/harness-image.md) lists it in full.

## Before you start

- Thermite's harness image, built and pushed to your registry: see [Push the images to your own registry](own-registry.md). Extend the CPU image for CPU rigs and the CUDA image for GPU rigs.

## 1. Write a Containerfile

Start from the harness image and install with `apt-get`. This example adds a Fortran compiler and OpenBLAS:

```dockerfile title="Containerfile"
FROM registry.example.com/thermite/thermite-harness:1a2b3c4d5e6f
RUN apt-get update \
 && apt-get install -y --no-install-recommends gfortran libopenblas-dev \
 && rm -rf /var/lib/apt/lists/*
```

Keep these as they are, or the rig won't start or won't be safe to judge on:

| Keep | Why |
| --- | --- |
| **Root.** Add no `USER` line | The harness starts as root and runs each kind of work as its own user. As another user it stops with `fatal: not root, so roles cannot be separated` |
| **`ENTRYPOINT` and `CMD`.** Don't set them | They start the harness |
| **Thermite's users and groups.** Don't remove, renumber or reuse them | Their ids are fixed in Thermite's code. The [harness image reference](../../reference/harness-image.md) lists them |
| **`/outbox`**, owned by user 10010 and group 10001, mode 2750 | The harness writes exports there and the supervisor reads them |
| **`/opt/thermite`** | Thermite itself, and in `/opt/thermite/checks` the kits and projects of the smoke check |

## 2. Put tools where every user finds them

Builds, timed runs and the agents' commands run as Thermite's own users, not as root. They don't get the image's environment: only `PATH` (the image's), `LANG`, their own `HOME`, `TMPDIR` and `USER`, and a few settings Thermite gives them itself.

- Install tools where every user can run them, such as `/usr/bin` or `/usr/local/bin`, not under `/root`.
- `ENV PATH=…` in your Containerfile reaches them. Other `ENV` lines, such as `LD_LIBRARY_PATH`, do not: register library folders with the system's linker (`ldconfig`) instead.
- Don't rely on files in a home folder: each process's home is its own working folder.

## 3. Build and push it

Give it a name and a tag of its own, and use a new tag for every build: a machine never pulls a tag it already has.

```sh
docker build -t registry.example.com/thermite/thermite-harness-fortran:1a2b3c4d5e6f-1 -f Containerfile .
docker push registry.example.com/thermite/thermite-harness-fortran:1a2b3c4d5e6f-1
```

With Podman, use `podman build` and `podman push`.

## 4. Use it for new rigs

Set control's harness image to yours, then restart control (with the compose stack: in `.env`, then `docker compose up -d` with your `-f` options):

- `THERMITE_RIG_HARNESS_IMAGE` for CPU rigs;
- `THERMITE_RIG_HARNESS_CUDA_IMAGE` for GPU rigs.

**Rigs › Add a rig** shows it under **Images**, and every rig you add from then on runs it. A rig keeps the image it was set up with: control can't move an existing rig to a new image yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)), so add a new rig.

Thermite doesn't know which rigs carry your tools. A kit names only its target (`cpu` or `cuda-gpu`), and on a rig without the tools the judge's builds of your project fail. Start campaigns that need them only on rigs added from your image; a name that says so, such as `rig-fortran-1`, helps.

### On the local stack

The local compose stack builds its harness from your clone and has no setting for another image ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). To give its rig the tools, add the packages to the first `apt-get install` line in your clone's `containers/harness/Containerfile` (the one that lists `gcc`), then rebuild:

```sh
docker compose up -d --build harness     # or: podman compose up -d --build harness
```

Add your `-f` options if you use [override files](one-machine.md#settings-and-override-files). The change stays in your clone, so a later `git pull` may ask you to merge it.

## Check that it worked

On the new rig's page (on the local stack, the page of `local-1`, from step 2 on):

1. The **Set up by control** block's **Images** names your image. (A rig you joined yourself shows it under **You run it yourself**.)
2. Run **Isolation** and **Judge smoke** ([Check a rig](../operate/check-a-rig.md)). Both must pass, as on Thermite's own image.
3. Run your kit with no agents, so the judge builds your project with the new tools: see [Test a kit with known candidates](../campaigns/test-a-kit.md).
