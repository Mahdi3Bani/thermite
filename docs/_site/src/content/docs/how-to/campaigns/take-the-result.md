---
title: "Take the result"
description: "Download a run's best change as a patch and apply it to your project."
type: how-to
sidebar:
  order: 12
---

A run's result is its [champion](../../reference/glossary.md): the best version of your project that the judge has confirmed. Thermite never pushes to your project. You download the champion as a patch and apply it yourself, to the commit the run started from.

## Before you start

- The run has a champion beyond its starting point: on the run's **Overview** tab, **The run** block shows **Champion** as `#2` or higher. The starting point itself is champion #1.
- The rig has published that champion with an export. Exports happen every hour when there is something new, while the rig's **Exports** switch on **Edit rig** is on. To publish at once, open the rig's page and press **Export now**.
- A minute or two after the export, the rig's supervisor has uploaded the patch to control. Control keeps it only if it matches what the rig published. This works on every rig, with or without a results repository.

## 1. Download the patch

1. Open **Campaigns**, then the campaign. A campaign whose runs have all finished shows only when you choose the filter **All**. Open the run: press its name on its card under **At work now**, or in its row under **Earlier runs**. The run's page opens on its **Overview** tab.
2. In the block **The run**, beside **Champion**, press the link **download champion #N as a patch**. The link shows only once the rig has exported the champion: press **refresh** after **Export now**. The note beside it, such as `(applies to 0123abcd)`, names the commit the patch applies to: the run's starting commit.

The champion's own page, which you reach from its row under **Champions** or **Attempts**, has the same link. To see whether another rig's judge has confirmed the champion too, see [Run a campaign on several rigs](several-rigs.md#4-check-the-result).

The file is named `<run>-champion-<n>-on-<commit>.patch`, such as `sort-speed-1-champion-3-on-0123abcd.patch`. If you see `No patch for that champion yet.`, the rig has not exported since the promotion, or the upload has not arrived: press **Export now** on the rig's page, wait a minute or two, and try again.

## 2. Apply it

The patch holds every change from the run's starting commit to the champion, binary files included. Apply it to a checkout of that commit, here `0123abcd`:

```sh
git clone https://git.example.com/you/project.git
cd project
git checkout 0123abcd
git apply --check ~/Downloads/sort-speed-1-champion-3-on-0123abcd.patch
git apply ~/Downloads/sort-speed-1-champion-3-on-0123abcd.patch
```

`git apply --check` prints nothing when the patch applies cleanly. Then build and test the project as you usually do, and commit the change on a branch of your own.

If your branch has moved on since that commit, either commit the change on a branch made from that commit and merge it into yours, or apply it on your branch with `git apply -3`, which falls back on a three-way merge and marks any conflicts. `-3` needs that commit in your clone.

## Download it from a script

Control serves the same patch over the REST API, with the owner's token. The example uses the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

```sh
curl -sS -D headers.txt -o champion.patch \
  -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  http://127.0.0.1:8800/v1/rigs/local-1/champions/sort-speed-1/3/patch
```

The headers name the full starting commit in `x-thermite-base-commit` and the patch's SHA-256 in `x-thermite-sha256`. Compare the SHA-256 with the file's own: `sha256sum champion.patch` on Linux, `shasum -a 256 champion.patch` on a Mac. Before the patch is there, control answers `404` with `{"error":"no patch for that champion"}`.

## Keep every result

When the rig pushes to a results repository, each export there also holds the champion as `champions/<run>/<n>.patch`, with `champions/<run>/<n>.json` beside it, on the branch `thermite/<rig>/attempts`. That repository is the lasting copy of a rig's results. See [Set up the results repository](../operate/results-repository.md). Rigs that control sets up have no results repository yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)): download each champion you want to keep.
