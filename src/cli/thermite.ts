#!/usr/bin/env node
import { errorText } from "../common/errors.ts";
import { thermiteCampaign, thermiteRun } from "./thermite/campaigns.ts";
import { thermiteAssign, thermiteAssignPayload, thermiteCommand } from "./thermite/issue.ts";
import { thermiteKit } from "./thermite/kits.ts";
import {
  thermiteContract,
  thermiteDoctor,
  thermiteKeys,
  thermiteLocal,
  thermiteSelftest,
  thermiteToken,
} from "./thermite/local.ts";
import { thermiteMcp } from "./thermite/mcp.ts";
import { thermiteStatus, thermiteSubmit } from "./thermite/proposer.ts";
import { thermiteRig } from "./thermite/rigs.ts";
import { thermiteRunpod } from "./thermite/runpod.ts";
import { fail } from "./thermite/shared.ts";
import { USAGE } from "./thermite/usage.ts";

/**
 * The thermite command line: the machine's checks, contract checks, key generation, issuing
 * commands through control, and the scripted proposer's submit/status calls against a harness.
 * Each command is a function in a module of thermite/, and the usage text is thermite/usage.ts.
 */

export { formatMcpServers } from "./thermite/mcp.ts";

async function main(argv: string[]): Promise<void> {
  // --instance and --unit are the flags' names before the 2026-10-15 rename: still read.
  const [cmd, ...rest] = argv.map((a) =>
    a.replace(/^--instance(?==|$)/, "--run").replace(/^--unit(?==|$)/, "--rig"),
  );
  switch (cmd) {
    case "doctor":
      return thermiteDoctor(rest);
    case "contract":
      return thermiteContract(rest);
    case "keys":
      return thermiteKeys(rest);
    case "token":
      return thermiteToken(rest);
    case "assign-payload":
      return thermiteAssignPayload(rest);
    case "assign":
      return thermiteAssign(rest);
    case "rig":
      return thermiteRig(rest);
    case "runpod":
      return thermiteRunpod(rest);
    case "run":
      return thermiteRun(rest);
    case "campaign":
      return thermiteCampaign(rest);
    case "kit":
      return thermiteKit(rest);
    case "mcp":
      return thermiteMcp(rest);
    case "command":
      return thermiteCommand(rest);
    case "submit":
      return thermiteSubmit(rest);
    case "status":
      return thermiteStatus(rest);
    case "local":
      return thermiteLocal(rest);
    case "selftest":
      return thermiteSelftest(rest);
    default:
      process.stdout.write(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err) => fail(errorText(err)));
