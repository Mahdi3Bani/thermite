import { randomBytes } from "node:crypto";
import { redact } from "../../common/env.ts";
import { shellQuote } from "../../common/exec.ts";
import { RIG_ID, RIG_ID_WORDS } from "../../core/ids.ts";

/**
 * A rig on a machine control reaches over SSH, as files and Podman Quadlet units: the same two
 * containers, users, capabilities, networks and volumes as the compose rig, run as systemd
 * services of the machine's user (or the system's, when control logs in as root). Control
 * renders everything here and sends it in one script on standard input; the tokens are inside
 * that script, never on a command line.
 */

export interface RigPlan {
  rig: string;
  /** Control as the rig reaches it. */
  controlUrl: string;
  images: { harness: string; supervisor: string };
  /**
   * The machine's GPU indices the rig uses: none (CPU), one (shared by the judge and the agents)
   * or several: the first judgeGpus for the judge, the rest for the agents' dev runs.
   */
  gpus: number[];
  /** With two or more GPUs, how many are the judge's (default: half, rounded up). */
  judgeGpus?: number | undefined;
  /** Control logs in as root: system units and paths instead of the user's. */
  root: boolean;
  controlPublicKey: string;
  controlFingerprint: string;
}

export interface RigSecrets {
  /** The rig's token for control, minted by control at enrollment. */
  controlToken: string;
  /** Shared by the rig's harness and supervisor. */
  harnessSupervisorToken: string;
}

/** At most 8 judge GPUs and 8 for the agents (the harness image has users for that many). */
export const MAX_RIG_GPUS = 16;

/**
 * The harness's GPU settings for a rig with `n` GPUs, as the container numbers them (0 to n-1,
 * in the order given): none, one shared, or the GPU set with the judge's share to start with (the
 * first `judge` for the judge, the rest for the agents' dev runs; default half, rounded up). A
 * campaign deployed on the rig, or Edit rig, may change the share later (the rig's settings).
 */
export function gpuSplit(
  n: number,
  judge?: number | undefined,
): { THERMITE_GPU_INDEX?: string; THERMITE_GPUS?: string; THERMITE_JUDGE_GPUS?: string } {
  if (n > MAX_RIG_GPUS) throw new Error(`a rig takes at most ${MAX_RIG_GPUS} GPUs`);
  if (n === 0) return {};
  if (n === 1) return { THERMITE_GPU_INDEX: "0" };
  const j = judge ?? Math.ceil(n / 2);
  if (!Number.isInteger(j) || j < 1 || j > n - 1 || j > 8 || n - j > 8)
    throw new Error(
      `with ${n} GPUs the judge takes 1 to ${Math.min(8, n - 1)} of them, and the agents at most 8`,
    );
  return {
    THERMITE_GPUS: Array.from({ length: n }, (_, i) => i).join(","),
    THERMITE_JUDGE_GPUS: String(j),
  };
}

/** Where the rig's files and units live on the machine. */
export function rigPaths(p: Pick<RigPlan, "rig" | "root">) {
  return p.root
    ? {
        dir: `/var/lib/thermite/rigs/${p.rig}`,
        units: "/etc/containers/systemd",
        unitDir: `/var/lib/thermite/rigs/${p.rig}`,
        systemctl: "systemctl",
      }
    : {
        dir: `$HOME/.local/share/thermite/rigs/${p.rig}`,
        units: "$HOME/.config/containers/systemd",
        // Inside a user unit, %h is the user's home.
        unitDir: `%h/.local/share/thermite/rigs/${p.rig}`,
        systemctl: "systemctl --user",
      };
}

/** A user's systemd needs its runtime directory, which an SSH session may not have set. */
const userSession = (root: boolean) =>
  root
    ? []
    : [
        `if ! env | grep -q '^XDG_RUNTIME_DIR='; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi`,
      ];

export const unitName = (rig: string, part: "harness" | "supervisor") => `thermite-${rig}-${part}`;

/** What a rig's units are made of: the rest of a plan is for its first setup. */
export type UnitPlan = Pick<
  RigPlan,
  "rig" | "controlUrl" | "images" | "gpus" | "judgeGpus" | "root"
>;

/** The Quadlet units, by file name. */
export function rigUnits(p: UnitPlan): Record<string, string> {
  const { unitDir } = rigPaths(p);
  const h = unitName(p.rig, "harness");
  const s = unitName(p.rig, "supervisor");
  const net = `thermite-${p.rig}`;
  const egress = `thermite-${p.rig}-egress`;
  const split = gpuSplit(p.gpus.length, p.judgeGpus);
  const gpu = p.gpus.length > 0;
  const env = (pairs: Record<string, string>) =>
    Object.entries(pairs)
      .map(([k, v]) => `Environment=${k}=${v}`)
      .join("\n");
  const secret = (file: string, mode = "ro") =>
    `Volume=${unitDir}/${file}:/run/secrets/${file.split("/").pop()}:${mode},Z`;
  return {
    [`${net}.network`]: `# Thermite rig ${p.rig}: harness and supervisor only.
[Network]
NetworkName=${net}
Internal=true
`,
    [`${egress}.network`]: `# Thermite rig ${p.rig}: the way out (DNS, the internet, control).
[Network]
NetworkName=${egress}
`,
    [`${h}.container`]: `# Thermite rig ${p.rig}: the harness (judge, agents, broker).
[Unit]
Description=Thermite rig ${p.rig}: harness

[Container]
Image=${p.images.harness}
ContainerName=${h}
${env({
  THERMITE_RIG_ID: p.rig,
  THERMITE_TARGET: gpu ? "cuda-gpu" : "cpu",
  ...split,
  THERMITE_CONTROL_PUBKEY_FILE: "/keys/control-signing.pub",
  THERMITE_SUPERVISOR_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
})}
Volume=thermite-${p.rig}-state:/var/lib/thermite
Volume=thermite-${p.rig}-scratch:/scratch
Volume=thermite-${p.rig}-inbox:/inbox:ro
Volume=thermite-${p.rig}-outbox:/outbox
Volume=${unitDir}/keys:/keys:ro,Z
${secret("secrets/harness-supervisor-token")}
Network=${net}.network
Network=${egress}.network
DropCapability=ALL
AddCapability=CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID
NoNewPrivileges=true
${p.gpus.map((_, i) => `AddDevice=nvidia.com/gpu=${p.gpus[i]}`).join("\n")}${gpu ? "\nSecurityLabelDisable=true" : ""}

[Service]
Restart=always

[Install]
WantedBy=default.target
`,
    [`${s}.container`]: `# Thermite rig ${p.rig}: the supervisor (relay to control, git, staging).
[Unit]
Description=Thermite rig ${p.rig}: supervisor
Requires=${h}.service
After=${h}.service

[Container]
Image=${p.images.supervisor}
ContainerName=${s}
${env({
  THERMITE_RIG_ID: p.rig,
  HARNESS_URL: `http://${h}:8700`,
  CONTROL_URL: p.controlUrl.replace(/\/$/, ""),
  THERMITE_HARNESS_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
  THERMITE_CONTROL_TOKEN_FILE: "/run/secrets/control-rig-token",
})}
Volume=thermite-${p.rig}-supervisor:/var/lib/thermite-supervisor
Volume=thermite-${p.rig}-inbox:/inbox:U
Volume=thermite-${p.rig}-outbox:/outbox:ro
${secret("secrets/harness-supervisor-token")}
${secret("secrets/control-rig-token")}
Network=${net}.network
Network=${egress}.network
DropCapability=ALL
NoNewPrivileges=true

[Service]
Restart=always

[Install]
WantedBy=default.target
`,
  };
}

/** A heredoc that writes `content` to `path` (a shell word) with `mode`, unexpanded. */
function writeFile(path: string, content: string, mode: string): string {
  const end = `THERMITE_EOF_${randomBytes(8).toString("hex")}`;
  if (content.includes(end)) throw new Error("content collides with its heredoc marker");
  return `cat > ${path} <<'${end}'\n${content.endsWith("\n") ? content : `${content}\n`}${end}\nchmod ${mode} ${path}`;
}

/** The deploy script: the rig's files and units, then images pulled and services started. */
export function deployScript(p: RigPlan, secrets: RigSecrets): string {
  if (!RIG_ID.test(p.rig)) throw new Error(RIG_ID_WORDS);
  const { dir, units, systemctl } = rigPaths(p);
  const q = (path: string) => `"${path}"`;
  const lines = [
    "set -eu",
    ...userSession(p.root),
    "umask 077",
    `if [ -e ${q(dir)} ]; then echo "rig ${p.rig} exists on this machine already" >&2; exit 3; fi`,
    `mkdir -p ${q(`${dir}/secrets`)} ${q(`${dir}/keys`)} ${q(units)}`,
    // The directory keeps the files to its owner; the containers read them as their own users.
    `chmod 0700 ${q(dir)}`,
    // Control's public key is no secret, and the harness's controller reads it as its own user
    // (not the container's root): under umask 077 that user could not enter the keys folder.
    `chmod 0755 ${q(`${dir}/keys`)}`,
    writeFile(q(`${dir}/secrets/control-rig-token`), secrets.controlToken, "0644"),
    writeFile(q(`${dir}/secrets/harness-supervisor-token`), secrets.harnessSupervisorToken, "0644"),
    writeFile(q(`${dir}/keys/control-signing.pub`), p.controlPublicKey, "0644"),
    writeFile(q(`${dir}/keys/control-signing.fingerprint`), p.controlFingerprint, "0644"),
    ...Object.entries(rigUnits(p)).map(([name, text]) =>
      writeFile(q(`${units}/${name}`), text, "0644"),
    ),
    `${systemctl} daemon-reload`,
    `for image in ${shellQuote(p.images.harness)} ${shellQuote(p.images.supervisor)}; do podman image exists "$image" || podman pull -q "$image" >/dev/null; done`,
    `${systemctl} start ${unitName(p.rig, "harness")}.service ${unitName(p.rig, "supervisor")}.service`,
    `echo started`,
  ];
  return lines.join("\n");
}

/**
 * The update script: a rig control set up moves onto other images. The images are pulled first,
 * while the rig still runs; then its two container units are written again and both services
 * restart. Its secrets, keys, volumes and networks stay, so its ledger, runs, tokens and key do.
 * An image the registry no longer serves but the machine holds is used as it is.
 */
export function updateScript(p: UnitPlan): string {
  if (!RIG_ID.test(p.rig)) throw new Error(RIG_ID_WORDS);
  const { dir, units, systemctl } = rigPaths(p);
  const q = (path: string) => `"${path}"`;
  const containers = Object.entries(rigUnits(p)).filter(([name]) => name.endsWith(".container"));
  return [
    "set -eu",
    ...userSession(p.root),
    "umask 077",
    `if [ ! -d ${q(dir)} ]; then echo "rig ${p.rig} is not on this machine" >&2; exit 3; fi`,
    `for image in ${shellQuote(p.images.harness)} ${shellQuote(p.images.supervisor)}; do podman pull -q "$image" >/dev/null || podman image exists "$image"; done`,
    ...containers.map(([name, text]) => writeFile(q(`${units}/${name}`), text, "0644")),
    `${systemctl} daemon-reload`,
    `${systemctl} restart ${unitName(p.rig, "harness")}.service ${unitName(p.rig, "supervisor")}.service`,
    "echo updated",
  ].join("\n");
}

/**
 * The check script (read-only): whether the rig's two services are active, its containers' states,
 * and the supervisor's last log lines, which say why a rig that runs does not report.
 */
export function checkScript(p: Pick<RigPlan, "rig" | "root">): string {
  if (!RIG_ID.test(p.rig)) throw new Error(RIG_ID_WORDS);
  const { systemctl } = rigPaths(p);
  const h = unitName(p.rig, "harness");
  const s = unitName(p.rig, "supervisor");
  return [
    "set -u",
    ...userSession(p.root),
    `echo "harness=$(${systemctl} is-active ${h}.service 2>/dev/null || true)"`,
    `echo "supervisor=$(${systemctl} is-active ${s}.service 2>/dev/null || true)"`,
    `podman ps -a --filter name=${shellQuote(`^(${h}|${s})$`)} --format 'ps={{.Names}}|{{.Status}}' 2>/dev/null || true`,
    `podman logs --tail 3 ${s} 2>&1 | tail -n 3 | sed 's/^/log=/' || true`,
  ].join("\n");
}

/** What the check script found, in words: ok when both services are active. */
export function readCheck(rig: string, out: string): { ok: boolean; words: string } {
  const lines = out.split("\n").map((l) => l.trim());
  const val = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) || "";
  const states = {
    harness: val("harness") || "unknown",
    supervisor: val("supervisor") || "unknown",
  };
  const status = (part: "harness" | "supervisor") =>
    lines
      .find((l) => l.startsWith(`ps=${unitName(rig, part)}|`))
      ?.split("|")[1]
      ?.trim() ?? "";
  const ok = states.harness === "active" && states.supervisor === "active";
  const part = (name: "harness" | "supervisor") =>
    `the ${name} is ${states[name] === "active" ? "running" : states[name]}${status(name) ? ` (${status(name).toLowerCase()})` : ""}`;
  const said = ok
    ? `Both containers run: ${part("harness")}, ${part("supervisor")}.`
    : `Not both containers run: ${part("harness")}, ${part("supervisor")}.`;
  const log = lines
    .filter((l) => l.startsWith("log="))
    .map((l) => l.slice(4).trim())
    .filter(Boolean)
    .map((l) => l.slice(0, 200));
  return {
    ok,
    words: redact(
      log.length ? `${said} The supervisor's last log lines: ${log.join(" · ")}` : said,
    ).slice(0, 900),
  };
}

export type RigAction = "stop" | "start" | "restart" | "remove" | "status";

/** Managing a rig control set up: its services, and removing its units, files and volumes. */
export function manageScript(p: Pick<RigPlan, "rig" | "root">, action: RigAction): string {
  if (!RIG_ID.test(p.rig)) throw new Error(RIG_ID_WORDS);
  const { dir, units, systemctl } = rigPaths(p);
  const services = `${unitName(p.rig, "supervisor")}.service ${unitName(p.rig, "harness")}.service`;
  const body: Record<RigAction, string[]> = {
    stop: [`${systemctl} stop ${services}`],
    start: [`${systemctl} start ${services.split(" ").reverse().join(" ")}`],
    restart: [`${systemctl} restart ${services.split(" ").reverse().join(" ")}`],
    status: [`${systemctl} is-active ${services} || true`],
    remove: [
      `${systemctl} stop ${services} || true`,
      `rm -f "${units}/thermite-${p.rig}-harness.container" "${units}/thermite-${p.rig}-supervisor.container" "${units}/thermite-${p.rig}.network" "${units}/thermite-${p.rig}-egress.network"`,
      `${systemctl} daemon-reload`,
      `podman volume rm -f thermite-${p.rig}-state thermite-${p.rig}-scratch thermite-${p.rig}-inbox thermite-${p.rig}-outbox thermite-${p.rig}-supervisor >/dev/null 2>&1 || true`,
      `podman network rm -f thermite-${p.rig} thermite-${p.rig}-egress >/dev/null 2>&1 || true`,
      `rm -rf "${dir}"`,
      "echo removed",
    ],
  };
  return ["set -eu", ...userSession(p.root), ...body[action]].join("\n");
}
