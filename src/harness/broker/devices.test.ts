import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { deviceProbes } from "../selftest.ts";
import {
  type GpuLayout,
  identityFor,
  LAYOUT_FILE,
  nodeGroups,
  parseMinor,
  planDedicated,
  procBusDir,
  readLayout,
} from "./devices.ts";
import { launch } from "./process.ts";
import { IDS } from "./runner.ts";

// Shaped like two cards in one container (no real host data).
const SMI = `0, GPU-aaaaaaaa-0000-0000-0000-000000000000, 00000000:3B:00.0
1, GPU-bbbbbbbb-0000-0000-0000-000000000000, 00000000:D8:00.0
`;
const INFO: Record<string, string> = {
  "0000:3b:00.0": "Model: Tesla P100-PCIE-16GB\nDevice Minor: 6\n",
  "0000:d8:00.0": "Model: Tesla P100-PCIE-16GB\nDevice Minor: 7\n",
};
const NODES = ["/dev/nvidia6", "/dev/nvidia7", "/dev/nvidiactl", "/dev/nvidia-uvm"];
const plan = (over: Partial<Parameters<typeof planDedicated>[0]> = {}) =>
  planDedicated({
    smiCsv: SMI,
    information: (bus) => {
      const i = INFO[bus];
      if (!i) throw new Error(`no ${bus}`);
      return i;
    },
    nodes: NODES,
    judgeIndex: 0,
    devIndex: 1,
    ...over,
  });

describe("a dedicated development card", () => {
  test("the layout maps nvidia-smi's cards to their nodes through the driver's minors", () => {
    assert.equal(procBusDir("00000000:3B:00.0"), "0000:3b:00.0");
    assert.equal(parseMinor(INFO["0000:d8:00.0"] as string), 7);
    assert.equal(
      parseMinor("GPU 00000000:D8:00.0\n    Minor Number                          : 7\n"),
      7,
    );
    const l = plan();
    assert.equal(l.judge.node, "/dev/nvidia6");
    assert.equal(l.dev.node, "/dev/nvidia7");
    assert.equal(l.dev.uuid, "GPU-bbbbbbbb-0000-0000-0000-000000000000");
    assert.deepEqual(l.control, ["/dev/nvidiactl", "/dev/nvidia-uvm"]);
    assert.deepEqual(nodeGroups(l), [
      { node: "/dev/nvidia6", gid: IDS.gpuGroup },
      { node: "/dev/nvidia7", gid: IDS.gpuDevGroup },
      { node: "/dev/nvidiactl", gid: IDS.gpuCtlGroup },
      { node: "/dev/nvidia-uvm", gid: IDS.gpuCtlGroup },
    ]);
  });

  test("anything unexpected stops the layout", () => {
    assert.throws(() => plan({ devIndex: 0 }), /both index 0/);
    assert.throws(() => plan({ devIndex: 2 }), /no GPU with index 2/);
    assert.throws(() => plan({ nodes: NODES.filter((n) => n !== "/dev/nvidia7") }), /missing/);
    assert.throws(() => plan({ nodes: [...NODES, "/dev/nvidia8"] }), /more cards/);
    assert.throws(() => plan({ information: () => "no minor here" }), /Device Minor/);
  });

  test("each side gets its own card, the shared nodes, and CUDA pointed at its card", () => {
    const l = plan();
    const ctl = [IDS.gpuCtlGroup];
    assert.deepEqual(identityFor("run", false, l), {
      uid: IDS.run.uid,
      gid: IDS.gpuGroup,
      groups: ctl,
      cuda: l.judge.uuid,
    });
    for (const [role, gpu] of [
      ["lane-2", true],
      ["lane-2-dev", false],
    ] as const) {
      const id = identityFor(role, gpu, l);
      assert.equal(id.gid, IDS.gpuDevGroup, role);
      assert.deepEqual(id.groups, ctl, role);
      assert.equal(id.cuda, l.dev.uuid, role);
    }
    for (const role of ["builder", "lane-2", "agent-2"] as const) {
      const id = identityFor(role, false, l);
      assert.equal(id.groups, undefined, role);
      assert.notEqual(id.gid, IDS.gpuGroup, role);
    }
    // Shared mode is unchanged: the gpu group for run and dev runs, nothing else.
    assert.deepEqual(identityFor("run", false), { uid: IDS.run.uid, gid: IDS.gpuGroup });
    assert.deepEqual(identityFor("lane-2", true), { uid: 10102, gid: IDS.gpuGroup });
  });

  test("supplementary groups go through setpriv; without them nothing changes", () => {
    const base = { argv: ["nvidia-smi", "-L"], uid: 10030, gid: 10500, nproc: 256 };
    assert.deepEqual(launch(base, "/usr/bin/setpriv", "/usr/bin/prlimit"), {
      argv: ["/usr/bin/prlimit", "--nproc=256", "--", "nvidia-smi", "-L"],
      uid: 10030,
      gid: 10500,
    });
    assert.deepEqual(launch({ ...base, groups: [10502] }, "/usr/bin/setpriv", "/usr/bin/prlimit"), {
      argv: [
        "/usr/bin/setpriv",
        "--reuid=10030",
        "--regid=10500",
        "--groups=10502",
        "--",
        "/usr/bin/prlimit",
        "--nproc=256",
        "--",
        "nvidia-smi",
        "-L",
      ],
    });
    assert.throws(() => launch({ ...base, groups: [10502] }, undefined), /setpriv/);
  });

  test("the controller reads the broker's layout, or why there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-layout-"));
    const sock = join(dir, "broker.sock");
    assert.match(String(readLayout(undefined).error), /needs the broker/);
    assert.match(String(readLayout(sock).error), /no device layout/);
    writeFileSync(
      join(dir, LAYOUT_FILE),
      JSON.stringify({ ok: false, mode: "dedicated", error: "x" }),
    );
    assert.match(String(readLayout(sock).error), /not set up: x/);
    writeFileSync(join(dir, LAYOUT_FILE), JSON.stringify({ ok: true, ...plan() }));
    assert.equal(readLayout(sock).layout?.dev.node, "/dev/nvidia7");
  });

  test("the selftest probes each side's reach and refusal", () => {
    const l: GpuLayout = plan();
    const by = (side: "judge" | "dev" | "other", layout?: GpuLayout) =>
      Object.fromEntries(deviceProbes(NODES, side, layout).map((p) => [p.name, p.op]));
    assert.deepEqual(by("judge", l), {
      "device:nvidia6": "reachable",
      "device:nvidiactl": "reachable",
      "device:nvidia-uvm": "reachable",
      "device:nvidia7": "access",
      "visible-gpus": "gpus",
    });
    assert.deepEqual(by("dev", l), {
      "device:nvidia7": "reachable",
      "device:nvidiactl": "reachable",
      "device:nvidia-uvm": "reachable",
      "device:nvidia6": "access",
      "visible-gpus": "gpus",
    });
    for (const layout of [l, undefined]) {
      assert.ok(Object.values(by("other", layout)).every((op) => op === "access"));
      assert.equal(Object.keys(by("other", layout)).length, NODES.length);
    }
    assert.deepEqual(by("judge"), {});
    assert.deepEqual(by("dev"), {});
    const gpus = deviceProbes(NODES, "dev", l).find((p) => p.op === "gpus");
    assert.equal(gpus?.expect, l.dev.uuid);
  });
});
