/** A local stand-in for Upstash's REST API (POST /multi-exec with INCR + PEXPIRE). Written from the official client's protocol; it is NOT Upstash. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubUpstash {
  url: string;
  token: string;
  /** Every Redis key the adapter touched (to prove no raw nonce/IP is sent). */
  keys: string[];
  requests: number;
  /** Set to make the next requests fail: HTTP status, or "hang". */
  fail: number | "hang" | null;
  close(): Promise<void>;
}

export async function startStubUpstash(token = "stub-token"): Promise<StubUpstash> {
  const store = new Map<string, { n: number; exp: number }>();
  const stub: StubUpstash = { url: "", token, keys: [], requests: 0, fail: null, close: async () => {} };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      stub.requests++;
      if (stub.fail === "hang") return; // never answers
      if (typeof stub.fail === "number") return void res.writeHead(stub.fail).end("{}");
      if (req.url !== "/multi-exec" || req.method !== "POST") return void res.writeHead(404).end("{}");
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
      const cmds = JSON.parse(body) as string[][];
      const now = Date.now();
      const out = cmds.map(([cmd, key, arg]) => {
        stub.keys.push(key!);
        const cur = store.get(key!);
        const live = cur && cur.exp > now ? cur : undefined;
        if (cmd === "INCR") {
          const n = (live?.n ?? 0) + 1;
          store.set(key!, { n, exp: live?.exp ?? Infinity });
          return { result: n };
        }
        if (cmd === "PEXPIRE") {
          const e = store.get(key!);
          if (e) e.exp = now + Number(arg);
          return { result: e ? 1 : 0 };
        }
        return { error: `ERR unknown command ${cmd}` };
      });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
  return stub;
}
