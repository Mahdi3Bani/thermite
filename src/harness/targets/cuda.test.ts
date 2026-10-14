import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CudaDriver, decodeReasons, parseGpuRows } from "./cuda.ts";

// nvidia-smi --format=csv,noheader,nounits output shaped like a 16 GB Pascal card (no real host data).
const IDLE =
  "0, GPU-00000000-1111-2222-3333-444444444444, Tesla P100-PCIE-16GB, 00000000:00:00.0, 550.00.00, 16384, 0, 16280, 0, 36, 31.20, 250.00, 405, 715, 1328, 715, P0";
const BUSY =
  "0, GPU-00000000-1111-2222-3333-444444444444, Tesla P100-PCIE-16GB, 00000000:00:00.0, 550.00.00, 16384, 9000, 7280, 97, 79, 210.00, 250.00, 1328, 715, 1328, 715, P0";

function fake(row: string, reasons: string, apps = "") {
  return async (args: string[]) => {
    const q = args[0] ?? "";
    if (q.startsWith("--query-compute-apps")) return apps;
    if (q.includes("clocks_event_reasons")) return `0, ${reasons}\n`;
    return `${row}\n`;
  };
}

describe("cuda-gpu driver", () => {
  test("parses nvidia-smi rows and clock event reasons", () => {
    const [r] = parseGpuRows(`${IDLE}\n`);
    assert.equal(r?.name, "Tesla P100-PCIE-16GB");
    assert.equal(r?.["memory.total"], "16384");
    assert.deepEqual(decodeReasons("0x0000000000000001"), ["gpu_idle"]);
    assert.deepEqual(decodeReasons("0x0000000000000048"), ["hw_slowdown", "hw_thermal_slowdown"]);
  });

  test("an idle, cool, unthrottled GPU is ready; its identity is the UUID", async () => {
    const d = new CudaDriver({
      targetClass: "p100-pcie-16g",
      smi: fake(IDLE, "0x0000000000000001"),
    });
    assert.deepEqual((await d.readyForTiming()).reasons, []);
    const id = await d.identify();
    assert.equal(id.id, "GPU-00000000-1111-2222-3333-444444444444");
    assert.equal(id.class, "p100-pcie-16g");
  });

  test("a busy, throttled GPU or one with compute processes is not ready", async () => {
    const d = new CudaDriver({
      targetClass: "p100-pcie-16g",
      smi: fake(BUSY, "0x0000000000000008", "4242, 8000\n"),
    });
    const r = await d.readyForTiming();
    assert.equal(r.ready, false);
    assert.equal(r.reasons.length, 4, r.reasons.join("; "));
  });

  test("never a score: zero, negative and non-finite metrics are implausible", () => {
    const d = new CudaDriver({ targetClass: "x", smi: fake(IDLE, "0x1") });
    assert.equal(d.plausibility({ a: 1, b: 0, c: Number.NaN }).length, 2);
  });
});
