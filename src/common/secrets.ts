import { timingSafeEqual } from "node:crypto";

/** Whether two secrets, such as tokens, are the same, compared in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
