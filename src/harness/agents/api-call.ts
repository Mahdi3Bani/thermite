import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * One call from a worker to the harness API. Not fetch: undici gives up on a response whose
 * headers take longer than 300 s, and a lane's run or dev run answers only when its command ends
 * (run_timeout_s allows up to 7200 s). Here no client timeout applies: the harness's own
 * per-command limits end every call.
 */
export function apiCall(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    // A fresh connection per call: no idle keep-alive socket the server may close under it.
    const req = send(u, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
