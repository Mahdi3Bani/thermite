---
title: "Bring a model's weights to a run"
description: "Have a rig download a large model file by URL, check its SHA-256, and show its progress, a gated Hugging Face model included."
type: how-to
sidebar:
  order: 14
---

Quantization and engine work need a model's weights on the rig. Weights are too large for a repository, so the contract names them as a [model file](../../reference/glossary.md) with its SHA-256, and the assignment says where to download them. The rig's supervisor downloads the file, shows how far it is, and hands the run only a file with that SHA-256.

## Before you start

- A rig that reports to control, and the owner's token in a file. See [Start a run from the command line](start-from-command-line.md).
- The file's URL and its SHA-256. On Hugging Face, the URL of one file is `https://huggingface.co/<org>/<model>/resolve/<commit>/<file>`, and the file's page shows its SHA-256 for a large file. Use a commit, not `main`: a branch can move to another file. Without a SHA-256 from the source, download the file once yourself and run `sha256sum` on it (`shasum -a 256` on a Mac).
- Free space on the rig for the file twice: the supervisor's copy in the inbox and the harness's own copy. On RunPod, both copies are on the pod's own disk, and again in the snapshot on its volume: give each room for the file twice. See [Where the file goes](../../reference/model-files.md#where-the-file-goes).

## 1. List the file in the contract

Add it under `models`, with the name you will use and its SHA-256:

```json title="contract.json (part)"
"models": [
  { "name": "llama-8b", "sha256": "5f0c0e8d6b1a4c7e9f2d3b4a5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d" }
]
```

The kit reads the file as `{models:<sha256>}`. See [Write a kit](write-a-kit.md). A model in several files, such as one in shards, is one entry for each file.

## 2. For a gated model, give the supervisor a token

Skip this step for a model anyone may download. For a gated one, accept the model's terms on huggingface.co, then make a token that may read (on huggingface.co, **Settings › Access Tokens**). Put it in a file only you may open, and give the file to the supervisor. On the local compose stack, with an override file:

```sh
mkdir -m 700 .dev/hf && printf '%s\n' 'hf_...' > .dev/hf/token
```

```yaml title="compose.hf.yaml"
services:
  supervisor:
    environment:
      THERMITE_HF_TOKEN_FILE: /run/secrets/hf-token
    secrets: [hf-token]
secrets:
  hf-token: { file: ./.dev/hf/token }
```

```sh
docker compose -f compose.yaml -f compose.hf.yaml up -d   # or: podman compose …
```

Name every override file you use on each `up`. The supervisor reads the token when it starts. It sends it only to Hugging Face, and no agent can read it. See [Gated models on Hugging Face](../../reference/model-files.md#gated-models-on-hugging-face).

## 3. Assign the run with the file's URL

Add `--model NAME=URL` for each file, and give the assignment time for the download with `--ttl`, in minutes:

```sh
npx thermite assign --contract contract.json --run quant-1 \
  --seed https://git.example.com/lab/engine.git \
  --model llama-8b=https://huggingface.co/example-org/llama-8b/resolve/0123abcd/model.safetensors \
  --ttl 600 --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig rig-1
```

It prints the command's id. The run starts only after every file is downloaded and checked. An assignment left with too little time expires while the file still downloads: see [Limits](../../reference/model-files.md#limits).

## 4. Watch the download

- Open the rig's page (**Rigs**, then the rig) and press **Live**. The supervisor's lines say `Model llama-8b: download started from huggingface.co (via …), 16.1 GB.`, then `… of 16.1 GB (30%) downloaded.` at every tenth.
- On the rig's page, the **Models** row of **The rig** block shows `llama-8b: downloading, 4.8 GB of 16.1 GB (30%)`. Press **refresh** in the status bar to see it move.

When it is done, Live says `Model llama-8b: 16.1 GB downloaded. Its SHA-256 matches the signed one.`, the **Models** row says `llama-8b: 16.1 GB, its SHA-256 checked`, and the run starts.

## If it fails

The command shows `failed` with the reason, after `staging:`. [The errors](../../reference/model-files.md#errors) lists them.

- **Refused: the SHA-256 did not match.** The file was deleted. Check the SHA-256 in the contract, and that the URL names a commit, not a branch.
- **HTTP 401 or 403 from Hugging Face.** The model is gated: do step 2, or accept its terms with the token's account.
- **Not enough free space.** Make room where the inbox is, then start the run again.
- **The download broke.** Start the run again with the same command and a new `--run` name. The download goes on from where it stopped.

A file the rig already has is checked and not downloaded again, so a second run with the same model starts at once.
