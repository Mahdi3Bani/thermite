import { sha256Hex } from "../../core/canonical.ts";
import { StorePart } from "./part.ts";

/**
 * Champions' patches (goal 125, T6), kept only when they are the ones the rig published.
 */

export class ChampionPatches extends StorePart {
  /**
   * A champion's patch from the rig's supervisor, kept only if it is the one the rig published
   * (the supervisor transports it; it cannot change it).
   */
  put(
    rig: string,
    run: string,
    seq: number,
    patch: Buffer,
  ): "stored" | "not_published" | "mismatch" {
    const pub = this.store.rigEvents.publishedChampion(rig, run, seq);
    if (!pub) return "not_published";
    if (sha256Hex(patch) !== pub.sha256) return "mismatch";
    this.db
      .prepare(
        `insert or ignore into champion_patch
           (rig, ledger_id, run, seq, sha256, base_commit, patch, received_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rig,
        pub.ledger_id,
        run,
        seq,
        pub.sha256,
        pub.base_commit,
        patch,
        new Date().toISOString(),
      );
    return "stored";
  }

  /** The patch of the champion the rig published last as `seq` of `run`: none until it arrives. */
  get(
    rig: string,
    run: string,
    seq: number,
  ): { patch: Buffer; sha256: string; base_commit: string } | undefined {
    const pub = this.store.rigEvents.publishedChampion(rig, run, seq);
    const r = this.db
      .prepare(
        `select patch, sha256, base_commit from champion_patch
           where rig = ? and ledger_id = ? and run = ? and seq = ?`,
      )
      .get(rig, pub?.ledger_id ?? "", run, seq) as
      | { patch: Uint8Array; sha256: string; base_commit: string }
      | undefined;
    return r
      ? { patch: Buffer.from(r.patch), sha256: r.sha256, base_commit: r.base_commit }
      : undefined;
  }
}
