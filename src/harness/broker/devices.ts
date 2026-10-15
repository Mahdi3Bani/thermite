import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { IDS, type Role, roleIds } from "./runner.ts";

/**
 * GPU device nodes and who may open them. On a rig with one card (shared mode) every
 * /dev/nvidia* node belongs to the `gpu` group, which the run user and agents' development runs
 * have. On a rig with a dedicated development card, the judge's card and the development card
 * each get their own group, and the nodes every CUDA process needs (nvidiactl, nvidia-uvm, ...)
 * a third, `gpuctl`. The run user then has `gpu` and `gpuctl`, and a development run has
 * `gpudev` and `gpuctl`: neither can open the other's card, whatever its environment says.
 */

export interface GpuCard {
  /** nvidia-smi's index. */
  index: number;
  uuid: string;
  /** PCI bus id as nvidia-smi prints it. */
  bus: string;
  /** The card's device node, /dev/nvidia<minor>. */
  node: string;
}

export interface GpuLayout {
  mode: "dedicated";
  judge: GpuCard;
  dev: GpuCard;
  /** Every other /dev/nvidia* node: control, UVM, modeset. */
  control: string[];
}

/** Where the broker records the layout, for the controller and the isolation selftest. */
export const LAYOUT_FILE = "gpu-layout.json";

/** The layout as the broker writes it: established, or why not. */
export type LayoutRecord =
  | ({ ok: true } & GpuLayout)
  | { ok: false; mode: "dedicated"; error: string };

/** `00000000:3B:00.0` (nvidia-smi) to `0000:3b:00.0` (/proc/driver/nvidia/gpus). */
export function procBusDir(bus: string): string {
  const m = /^([0-9a-fA-F]+):([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.([0-7])$/.exec(bus.trim());
  if (!m) throw new Error(`unexpected PCI bus id ${bus}`);
  const domain = (m[1] as string).slice(-4).padStart(4, "0");
  return `${domain}:${m[2]}:${m[3]}.${m[4]}`.toLowerCase();
}

/**
 * A card's minor number: "Device Minor" in /proc/driver/nvidia/gpus/<bus>/information, or
 * "Minor Number" in `nvidia-smi -q -i <index>`.
 */
export function parseMinor(information: string): number {
  const m = /^\s*(?:Device Minor|Minor Number)\s*:\s*(\d+)\s*$/m.exec(information);
  if (!m) throw new Error("no Device Minor in the driver's information");
  return Number(m[1]);
}

/**
 * Plans a dedicated layout from `nvidia-smi --query-gpu=index,uuid,pci.bus_id
 * --format=csv,noheader`, the driver's information per bus, and the /dev/nvidia* nodes present.
 */
export function planDedicated(opts: {
  smiCsv: string;
  /** The driver's information for a card, by /proc bus directory or nvidia-smi index. */
  information: (procBus: string, index: number) => string;
  nodes: string[];
  judgeIndex: number;
  devIndex: number;
}): GpuLayout {
  if (opts.judgeIndex === opts.devIndex) {
    throw new Error(`the judge's card and the development card are both index ${opts.judgeIndex}`);
  }
  const rows = opts.smiCsv
    .split("\n")
    .map((l) => l.split(",").map((f) => f.trim()))
    .filter((f) => f.length === 3 && /^\d+$/.test(f[0] as string));
  const card = (index: number, what: string): GpuCard => {
    const row = rows.find((f) => Number(f[0]) === index);
    if (!row) throw new Error(`no GPU with index ${index} for the ${what}`);
    const [, uuid, bus] = row as [string, string, string];
    const node = `/dev/nvidia${parseMinor(opts.information(procBusDir(bus), index))}`;
    if (!opts.nodes.includes(node)) throw new Error(`the ${what}'s node ${node} is missing`);
    return { index, uuid, bus, node };
  };
  const judge = card(opts.judgeIndex, "judge's card");
  const dev = card(opts.devIndex, "development card");
  const cardNode = /^\/dev\/nvidia\d+$/;
  const strays = opts.nodes.filter((n) => cardNode.test(n) && n !== judge.node && n !== dev.node);
  // A third card would be reachable through neither group, but nothing should be left unplanned.
  if (strays.length) throw new Error(`more cards than the layout covers: ${strays.join(", ")}`);
  return {
    mode: "dedicated",
    judge,
    dev,
    control: opts.nodes.filter((n) => !cardNode.test(n)),
  };
}

/** Owner group and mode for each node of a layout. */
export function nodeGroups(layout: GpuLayout): { node: string; gid: number }[] {
  return [
    { node: layout.judge.node, gid: IDS.gpuGroup },
    { node: layout.dev.node, gid: IDS.gpuDevGroup },
    ...layout.control.map((node) => ({ node, gid: IDS.gpuCtlGroup })),
  ];
}

export interface Identity {
  uid: number;
  gid: number;
  /** Supplementary groups (only on a dedicated layout). */
  groups?: number[] | undefined;
  /** CUDA_VISIBLE_DEVICES for the process (only on a dedicated layout). */
  cuda?: string | undefined;
}

/**
 * The user, groups and visible card a role runs with. `gpu` is a lane's development run on the
 * device. Without a dedicated layout this is the shared mode: such runs get the `gpu` group.
 */
export function identityFor(role: Role, gpu: boolean, layout?: GpuLayout | undefined): Identity {
  const ids = roleIds(role);
  const devUser = gpu || /^lane-\d+-dev$/.test(role);
  if (!layout) return { uid: ids.uid, gid: gpu ? IDS.gpuGroup : ids.gid };
  if (role === "run") {
    return { uid: ids.uid, gid: IDS.gpuGroup, groups: [IDS.gpuCtlGroup], cuda: layout.judge.uuid };
  }
  if (devUser) {
    return { uid: ids.uid, gid: IDS.gpuDevGroup, groups: [IDS.gpuCtlGroup], cuda: layout.dev.uuid };
  }
  return { uid: ids.uid, gid: ids.gid };
}

/**
 * The controller's view: the layout the broker established next to its socket, or why there is
 * none. Without one, a rig configured for a dedicated development card neither times nor runs
 * development runs.
 */
export function readLayout(socketPath: string | undefined): {
  layout?: GpuLayout;
  error?: string;
} {
  if (!socketPath) {
    return { error: "a dedicated development card needs the broker (the harness image, as root)" };
  }
  try {
    const r = JSON.parse(
      readFileSync(join(dirname(socketPath), LAYOUT_FILE), "utf8"),
    ) as LayoutRecord;
    if (!r.ok) return { error: `the dedicated development card is not set up: ${r.error}` };
    const { ok: _, ...layout } = r;
    return { layout };
  } catch (err) {
    return { error: `no device layout from the broker (${String(err)})` };
  }
}
