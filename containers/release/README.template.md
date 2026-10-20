# Thermite @@VERSION@@

This bundle starts Thermite on one computer from its published images. You get the control service (the dashboard, the REST API and MCP) and one rig, `local-1`, which runs on the CPU. You build nothing.

The bundle has two files: `compose.yaml` and this readme.

## What you need

- Linux or macOS, with a few CPU cores, a few gigabytes of free memory and about 3 GB of free disk for the images. With Podman on a Mac, that space must be free in Podman's virtual machine.
- Docker with Docker Compose, or Podman with `podman compose`.

## Start Thermite

The commands are for Docker. With Podman, write `podman compose` in place of `docker compose`.

1. Make an empty folder, and put `compose.yaml` in it:

   ```sh
   mkdir thermite && cd thermite
   curl -fsSLO @@REPO_URL@@/releases/download/@@TAG@@/compose.yaml
   ```

2. Make your tokens. This writes them to `.dev/secrets/` in the folder:

   ```sh
   docker compose run --rm init
   ```

3. Start Thermite. The first start downloads the images:

   ```sh
   docker compose up -d
   ```

4. Open <http://127.0.0.1:8800/ui>. Paste the token from `.dev/secrets/control-admin-token` into **Admin token**, then press **Sign in**.

Keep the folder: it holds your tokens. To stop Thermite, run `docker compose down` in the folder. Do not add `-v`: `down -v` deletes the volumes, and all that Thermite recorded with them.

## Next steps

- [Your first run](@@REPO_URL@@/blob/@@TAG@@/docs/_site/src/content/docs/tutorials/first-run.md): the quick start. It continues from step 4.
- [Install Thermite on one machine](@@REPO_URL@@/blob/@@TAG@@/docs/_site/src/content/docs/how-to/install/one-machine.md): settings, updates and rigs on other machines.

## The images

The compose file pins each image by its digest. The same images also have the tags below.

| Image | Pinned as | Tag |
| --- | --- | --- |
| Control | `@@CONTROL_IMAGE@@` | `@@CONTROL_TAG@@` |
| Harness, CPU | `@@HARNESS_IMAGE@@` | `@@HARNESS_TAG@@` |
| Harness, CUDA | `@@HARNESS_CUDA_IMAGE@@` | `@@HARNESS_CUDA_TAG@@` |
| Supervisor | `@@SUPERVISOR_IMAGE@@` | `@@SUPERVISOR_TAG@@` |

The compose file runs the CPU harness. Control sets rigs up on other machines and clusters from the CPU harness, the CUDA harness (for GPU rigs) and the supervisor. The images do not contain Claude Code.

The source code is at <@@REPO_URL@@>, under the MIT license.
