import type { Ledger } from "../ledger.ts";

/**
 * The checks research text shares (goal 112): a finding a worker records and an answer the review
 * panel gives are both held to them. Code runs them; the agents cannot.
 */

type Row = Record<string, unknown>;

/** Numbers as written (1,200 and 3.5 and 42), for checking claims, findings and answers. */
export function numbersIn(s: string): string[] {
  return [...s.matchAll(/\d[\d,.]*\d|\d/g)].map((m) => m[0]);
}

/** Every number a verified claim states: in its text or in its quotes. */
export function claimNumbers(claims: Row[]): Set<string> {
  return new Set(
    claims.flatMap((cl) => [
      ...numbersIn(String(cl.text)),
      ...(JSON.parse(String(cl.quotes)) as { quote: string }[]).flatMap((q) => numbersIn(q.quote)),
    ]),
  );
}

/**
 * Text that cites claims, checked: every cited id must be a verified claim of the run, and every
 * number in the texts must appear in those claims (their text or their quotes), or in `also`: the
 * numbers the harness itself gives the text's writer, such as a research paper's corpus figures.
 * Returns the verified claims cited and each problem in words; no problem means the text holds.
 */
export function checkCited(
  ledger: Ledger,
  run: string,
  cited: string[],
  texts: string[],
  also: Iterable<string> = [],
): { claims: Row[]; problems: string[] } {
  const problems: string[] = [];
  const claims: Row[] = [];
  for (const id of [...new Set(cited)]) {
    const cl = ledger.db.prepare("select * from claim where run = ? and id = ?").get(run, id) as
      | Row
      | undefined;
    if (!cl) problems.push(`no claim ${id}`);
    else if (Number(cl.verified) !== 1) problems.push(`claim ${id} is a draft, not verified`);
    else claims.push(cl);
  }
  const known = claimNumbers(claims);
  for (const n of also) known.add(n);
  for (const num of new Set(texts.flatMap(numbersIn))) {
    if (!known.has(num)) problems.push(`the number ${num} is not in the claims it cites`);
  }
  return { claims, problems };
}
