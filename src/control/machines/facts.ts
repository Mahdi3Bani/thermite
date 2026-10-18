/**
 * What control reads from a machine before it sets a rig up there, and reads again with "Check
 * again". The script only reads: it changes nothing on the machine. It prints one `key=value`
 * per line (GPUs one line each), so a missing tool is just a missing or empty value.
 */

export const CHECK_SCRIPT = `
set +e
PATH="$PATH:/usr/sbin:/sbin:/usr/local/bin"
say() { printf '%s=%s\\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
say os "$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s)"
say os_id "$( (. /etc/os-release 2>/dev/null && echo "$ID $ID_LIKE") )"
say kernel "$(uname -r)"
say arch "$(uname -m)"
say cpus "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"
say mem_kib "$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
say disk_free_kib "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
say user "$(id -un)"
say uid "$(id -u)"
if have nvidia-smi; then
  nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | sed 's/^/gpu=/'
  say driver "$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1)"
  say cuda "$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: *\\([0-9.]*\\).*/\\1/p' | head -n 1)"
fi
have podman && say podman "$(podman --version 2>/dev/null | awk '{print $NF}')"
have docker && say docker "$(docker --version 2>/dev/null | sed 's/^Docker version \\([^,]*\\).*/\\1/')"
have nvidia-ctk && say nvidia_ctk "$(nvidia-ctk --version 2>/dev/null | sed -n 's/.*version \\([0-9.]*\\).*/\\1/p' | head -n 1)"
for f in /var/run/cdi/nvidia.yaml /etc/cdi/nvidia.yaml; do [ -f "$f" ] && say cdi "$f" && break; done
have systemctl && say systemd "$(systemctl --version 2>/dev/null | awk 'NR==1 {print $2}')"
have loginctl && say linger "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
if [ "$(id -u)" = 0 ]; then say sudo root; elif have sudo && sudo -n true 2>/dev/null; then say sudo yes; else say sudo no; fi
reach() {
  if have curl; then curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null
  elif have wget; then wget -q -T 8 -O /dev/null "$1" 2>/dev/null && echo 200 || echo 0
  else echo none; fi
}
[ -n "$1" ] && say reaches_control "$(reach "$1")"
[ -n "$2" ] && say reaches_registry "$(reach "$2")"
exit 0
`;

export interface MachineGpu {
  index: number;
  uuid: string;
  name: string;
  memory_mib: number;
  used_mib: number;
  busy_pct: number;
}

export interface MachineFacts {
  os: string;
  /** os-release ID and ID_LIKE: which package manager a recipe uses. */
  os_id: string;
  kernel: string;
  arch: string;
  cpus: number;
  mem_kib: number;
  disk_free_kib: number;
  user: string;
  root: boolean;
  gpus: MachineGpu[];
  driver?: string | undefined;
  cuda?: string | undefined;
  podman?: string | undefined;
  docker?: string | undefined;
  nvidia_ctk?: string | undefined;
  cdi?: string | undefined;
  systemd?: string | undefined;
  linger?: boolean | undefined;
  sudo: boolean;
  /** HTTP status from control's health address, or 0/none when it could not be reached. */
  reaches_control?: string | undefined;
  reaches_registry?: string | undefined;
}

/** Parses the check's output. Unknown keys are ignored. */
export function parseFacts(text: string): MachineFacts {
  const one = new Map<string, string>();
  const gpus: MachineGpu[] = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const k = line.slice(0, at);
    const v = line.slice(at + 1).trim();
    if (k === "gpu") {
      const [index, uuid, name, total, used, util] = v.split(",").map((x) => x.trim());
      if (index !== undefined && /^\d+$/.test(index) && uuid && name)
        gpus.push({
          index: Number(index),
          uuid,
          name,
          memory_mib: Number(total) || 0,
          used_mib: Number(used) || 0,
          busy_pct: Number(util) || 0,
        });
    } else if (!one.has(k)) one.set(k, v);
  }
  const s = (k: string) => one.get(k) || undefined;
  const n = (k: string) => Number(one.get(k)) || 0;
  const linger = s("linger");
  return {
    os: s("os") ?? "unknown",
    os_id: s("os_id") ?? "",
    kernel: s("kernel") ?? "",
    arch: s("arch") ?? "",
    cpus: n("cpus"),
    mem_kib: n("mem_kib"),
    disk_free_kib: n("disk_free_kib"),
    user: s("user") ?? "",
    root: s("sudo") === "root",
    gpus: gpus.sort((a, b) => a.index - b.index),
    driver: s("driver"),
    cuda: s("cuda"),
    podman: s("podman"),
    docker: s("docker"),
    nvidia_ctk: s("nvidia_ctk"),
    cdi: s("cdi"),
    systemd: s("systemd"),
    linger: linger === undefined ? undefined : linger === "yes",
    sudo: s("sudo") === "yes" || s("sudo") === "root",
    reaches_control: s("reaches_control"),
    reaches_registry: s("reaches_registry"),
  };
}

/** What a rig needs from the machine and is missing, in the order a setup would fix it. */
export function missing(f: MachineFacts): ("podman" | "nvidia_toolkit" | "linger")[] {
  const out: ("podman" | "nvidia_toolkit" | "linger")[] = [];
  if (!f.podman) out.push("podman");
  if (f.gpus.length && (!f.nvidia_ctk || !f.cdi)) out.push("nvidia_toolkit");
  if (!f.root && f.systemd && f.linger === false) out.push("linger");
  return out;
}

/** A short line about the machine, for the Providers list. */
export function factsLine(f: MachineFacts): string {
  const gib = (kib: number) => Math.round(kib / 1024 / 1024);
  const gpus = f.gpus.length
    ? Object.entries(
        f.gpus.reduce<Record<string, number>>((m, g) => {
          m[g.name] = (m[g.name] ?? 0) + 1;
          return m;
        }, {}),
      )
        .map(([name, count]) => `${count} × ${name}`)
        .join(", ")
    : "no NVIDIA GPU";
  return [
    gpus,
    f.os,
    `${f.cpus} CPUs`,
    `${gib(f.mem_kib)} GB memory`,
    f.podman ? `Podman ${f.podman}` : f.docker ? `Docker ${f.docker}` : "no container engine",
  ].join(" · ");
}
