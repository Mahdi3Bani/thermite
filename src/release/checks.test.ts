import assert from "node:assert/strict";
import { test } from "node:test";
import { imageProblems, probeValues } from "./checks.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const clean = (env: string[] = []) => ({
  anonymous: true,
  env: [`THERMITE_COMMIT=${COMMIT}`, "THERMITE_IMAGE_ID=0.1.0-cuda+0123456789ab", ...env],
  probe: "claude=\nsocat=\nbwrap=\nsetid=\n",
});

test("an image that holds has no problem", () => {
  for (const key of ["control", "harness", "harness-cuda", "supervisor", "rig-cuda"] as const)
    assert.deepEqual(imageProblems(key, COMMIT, clean()), [], key);
});

test("one that does not pull without signing in says what to do, and nothing else", () => {
  assert.deepEqual(imageProblems("rig-cuda", COMMIT, { ...clean(), anonymous: false }), [
    "it does not pull without signing in: make its package public on GitHub (the package's settings, once), then run the checks again",
  ]);
});

test("the rig image is held to the lab's rules: no Claude Code, socat, bubblewrap, set-id file, key or STE checker", () => {
  const facts = {
    anonymous: true,
    env: [
      "THERMITE_COMMIT=feedface",
      "THERMITE_SNAPSHOT_KEY=abc",
      "THERMITE_STE_CHECKER=/opt/ste/check",
      "THERMITE_SNAPSHOT_DIR=/workspace/thermite",
      // A setting that names a file is a path, not a secret.
      "THERMITE_SUPERVISOR_TOKEN_FILE=/run/secrets/supervisor-token",
      "THERMITE_CONTROL_PUBKEY_FILE=/keys/control-signing.pub",
    ],
    probe:
      "claude=/usr/local/bin/claude \nsocat=/usr/bin/socat\nbwrap=/usr/bin/bwrap\nsetid=/usr/bin/su /usr/bin/passwd \n",
  };
  assert.deepEqual(imageProblems("rig-cuda", COMMIT, facts), [
    `it reports THERMITE_COMMIT "feedface", not the release's commit ${COMMIT}`,
    "it carries Claude Code (/usr/local/bin/claude): a published image never does",
    "it sets THERMITE_SNAPSHOT_KEY in its environment: no key, token or password goes in an image",
    "it does not report THERMITE_IMAGE_ID, which the harness puts in each build's key",
    "it carries socat (/usr/bin/socat)",
    "it carries bubblewrap (/usr/bin/bwrap)",
    "it has set-id files, which RunPod's root could run: /usr/bin/su /usr/bin/passwd",
    "it names an STE checker (THERMITE_STE_CHECKER): the checker is a deployment's own",
  ]);
});

test("set-id files, socat and the image ID are the rig's and the harnesses' rules, not control's", () => {
  const facts = {
    ...clean(),
    env: [`THERMITE_COMMIT=${COMMIT}`],
    probe: "claude=\nsocat=/usr/bin/socat\nbwrap=\nsetid=/usr/bin/su\n",
  };
  assert.deepEqual(imageProblems("control", COMMIT, facts), []);
  assert.deepEqual(imageProblems("harness", COMMIT, facts), [
    "it does not report THERMITE_IMAGE_ID, which the harness puts in each build's key",
    "it carries socat (/usr/bin/socat)",
  ]);
});

test("the probe's lines are read by name, each value trimmed", () => {
  assert.deepEqual(probeValues("claude=\nsetid=/a /b \nnoise\n"), { claude: "", setid: "/a /b" });
});
