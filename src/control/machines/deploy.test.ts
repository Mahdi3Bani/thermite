import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { deployScript, manageScript, type RigPlan, rigUnits } from "./deploy.ts";

const plan: RigPlan = {
  rig: "gpu-box-1-a",
  controlUrl: "https://control.example.com/",
  images: {
    harness: "registry.example.com/thermite/harness-cuda:0.2.0",
    supervisor: "registry.example.com/thermite/supervisor:0.2.0",
  },
  gpus: [2, 3],
  root: false,
  controlPublicKey: "-----PUBLIC KEY-----\nabc\n",
  controlFingerprint: "sha256:abcd",
};
const secrets = {
  controlToken: "rig-token-$(id)-'quoted'",
  harnessSupervisorToken: "sup-token-xyz",
};

describe("a rig deployed on a machine", () => {
  test("its units mirror the compose rig: two networks, the capabilities, the GPUs through CDI", () => {
    const u = rigUnits(plan);
    assert.deepEqual(Object.keys(u).sort(), [
      "thermite-gpu-box-1-a-egress.network",
      "thermite-gpu-box-1-a-harness.container",
      "thermite-gpu-box-1-a-supervisor.container",
      "thermite-gpu-box-1-a.network",
    ]);
    const h = u["thermite-gpu-box-1-a-harness.container"] ?? "";
    assert.match(h, /^Image=registry\.example\.com\/thermite\/harness-cuda:0\.2\.0$/m);
    assert.match(h, /^Environment=THERMITE_TARGET=cuda-gpu$/m);
    assert.match(h, /^Environment=THERMITE_GPUS=0,1$/m);
    assert.match(h, /^Environment=THERMITE_JUDGE_GPUS=1$/m);
    assert.match(h, /^AddDevice=nvidia\.com\/gpu=2\nAddDevice=nvidia\.com\/gpu=3$/m);
    assert.match(h, /^AddCapability=CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID$/m);
    assert.match(h, /^DropCapability=ALL$/m);
    assert.ok(!h.includes("control-rig-token"), "the harness never sees control's token");
    const s = u["thermite-gpu-box-1-a-supervisor.container"] ?? "";
    assert.match(s, /^Environment=CONTROL_URL=https:\/\/control\.example\.com$/m);
    assert.match(s, /^Environment=HARNESS_URL=http:\/\/thermite-gpu-box-1-a-harness:8700$/m);
    assert.match(s, /^Requires=thermite-gpu-box-1-a-harness\.service$/m);
    assert.match(u["thermite-gpu-box-1-a.network"] ?? "", /^Internal=true$/m);
    // A CPU rig has no devices; more GPUs are split, the lowest-numbered for the judge.
    const cpu = rigUnits({ ...plan, gpus: [] })["thermite-gpu-box-1-a-harness.container"] ?? "";
    assert.match(cpu, /^Environment=THERMITE_TARGET=cpu$/m);
    assert.ok(!/AddDevice|GPU_INDEX|THERMITE_GPUS/.test(cpu));
    const four =
      rigUnits({ ...plan, gpus: [2, 3, 5, 7], judgeGpus: 1 })[
        "thermite-gpu-box-1-a-harness.container"
      ] ?? "";
    assert.match(four, /^Environment=THERMITE_GPUS=0,1,2,3$/m);
    assert.match(four, /^Environment=THERMITE_JUDGE_GPUS=1$/m);
    assert.match(four, /^AddDevice=nvidia.com\/gpu=7$/m);
    assert.throws(() => rigUnits({ ...plan, gpus: [0, 1], judgeGpus: 2 }), /judge takes 1 to 1/);
    assert.throws(
      () => rigUnits({ ...plan, gpus: Array.from({ length: 17 }, (_, i) => i) }),
      /at most 16 GPUs/,
    );
  });

  test("the deploy script writes the tokens verbatim through stdin, refuses an existing rig, and starts the services", () => {
    const home = mkdtempSync(join(tmpdir(), "thermite-deploy-"));
    const bin = join(home, "bin");
    execFileSync("mkdir", ["-p", bin]);
    // Stand-ins that record what the script asked for.
    for (const tool of ["systemctl", "podman"])
      execFileSync("sh", [
        "-c",
        `printf '#!/bin/sh\\necho "${tool} $*" >> "$HOME/calls"\\n' > ${bin}/${tool} && chmod +x ${bin}/${tool}`,
      ]);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const script = deployScript(plan, secrets);
    assert.ok(
      !script.split("\n").some((l) => l.startsWith("printf") || /echo .*rig-token/.test(l)),
    );
    const out = execFileSync("sh", ["-s"], { input: script, env, encoding: "utf8" });
    assert.match(out, /started/);
    const dir = join(home, ".local/share/thermite/rigs/gpu-box-1-a");
    assert.equal(
      readFileSync(join(dir, "secrets/control-rig-token"), "utf8"),
      `${secrets.controlToken}\n`,
    );
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(
      readdirSync(join(home, ".config/containers/systemd")).sort(),
      Object.keys(rigUnits(plan)).sort(),
    );
    const calls = readFileSync(join(home, "calls"), "utf8");
    assert.match(calls, /^systemctl --user daemon-reload$/m);
    assert.match(
      calls,
      /^podman image exists registry\.example\.com\/thermite\/harness-cuda:0\.2\.0$/m,
    );
    assert.match(
      calls,
      /^systemctl --user start thermite-gpu-box-1-a-harness\.service thermite-gpu-box-1-a-supervisor\.service$/m,
    );
    // A second deploy of the same rig changes nothing.
    assert.throws(
      () => execFileSync("sh", ["-s"], { input: deployScript(plan, secrets), env, stdio: "pipe" }),
      /exists on this machine already/,
    );
    // Removing it takes its units and files away.
    execFileSync("sh", ["-s"], { input: manageScript(plan, "remove"), env });
    assert.deepEqual(readdirSync(join(home, ".config/containers/systemd")), []);
    assert.throws(() => statSync(dir));
  });
});
