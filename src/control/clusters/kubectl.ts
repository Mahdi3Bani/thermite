import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Control's way into a Kubernetes cluster it sets rigs up on: the kubectl in control's image,
 * with the cluster's kubeconfig in a 0600 file that exists only for the call. Control runs only
 * fixed read commands and applies only manifests it renders itself (manifests.ts), on stdin.
 */

export interface ClusterTarget {
  kubeconfig: string;
  /** The kubeconfig context to use; empty: its current context. */
  context?: string | undefined;
}

export interface KubectlResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A context or namespace name: what kubectl takes as a single argument. */
export const KUBE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,252}$/;

/** Runs kubectl with these arguments (never a shell), stdin if given. */
export async function kubectl(
  t: ClusterTarget,
  args: string[],
  stdin?: string,
  timeoutMs = 60_000,
): Promise<KubectlResult> {
  if (t.context && !KUBE_NAME.test(t.context)) throw new Error("the context name is not valid");
  const dir = mkdtempSync(join(tmpdir(), "thermite-kube-"));
  chmodSync(dir, 0o700);
  try {
    const config = join(dir, "config");
    writeFileSync(config, t.kubeconfig, { mode: 0o600 });
    const argv = [
      `--kubeconfig=${config}`,
      ...(t.context ? [`--context=${t.context}`] : []),
      "--request-timeout=30s",
      ...args,
    ];
    return await new Promise<KubectlResult>((resolve, reject) => {
      const child = spawn("kubectl", argv, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (signal === "SIGKILL")
          return reject(new Error(`kubectl did not finish within ${timeoutMs / 1000} s`));
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString(),
          stderr: Buffer.concat(err).toString(),
        });
      });
      child.stdin.end(stdin ?? "");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** kubectl's own failure, in a line. */
export const kubeError = (r: KubectlResult) =>
  (r.stderr.trim().split("\n").pop() ?? `kubectl exited ${r.code}`).replace(/^error: /i, "");

/** The contexts a kubeconfig holds, and its current one (read locally, nothing contacted). */
export async function contextsOf(
  kubeconfig: string,
): Promise<{ contexts: string[]; current: string }> {
  const names = await kubectl({ kubeconfig }, ["config", "get-contexts", "-o", "name"]);
  if (names.code !== 0)
    throw new Error(`that is not a kubeconfig kubectl can read: ${kubeError(names)}`);
  const current = await kubectl({ kubeconfig }, ["config", "current-context"]);
  return {
    contexts: names.stdout
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean),
    current: current.code === 0 ? current.stdout.trim() : "",
  };
}

/** The kubectl operations control uses (tests give their own). */
export interface ClusterKubectl {
  kubectl: typeof kubectl;
  contextsOf: typeof contextsOf;
}

export const realKubectl: ClusterKubectl = { kubectl, contextsOf };
