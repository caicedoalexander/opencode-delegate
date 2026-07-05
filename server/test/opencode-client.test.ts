import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpencodeClient, splitModel } from "../src/opencode-client.js";

let server: Server | undefined;
afterEach(() => server?.close());

interface Recorded {
  method: string;
  url: string;
  body: string;
}

// Respuesta real de POST /session/:id/message capturada en el spike
// (docs/superpowers/specs/2026-07-04-spike-opencode-serve-api.md), recortada.
const REAL_MESSAGE_RESPONSE = {
  info: {
    parentID: "msg_f2fff9ace001bzKplMbwPWSpAk",
    role: "assistant",
    mode: "build",
    agent: "build",
    modelID: "deepseek-v4-flash-free",
    providerID: "opencode",
    time: { created: 1783216709011, completed: 1783216713560 },
    finish: "stop",
    id: "msg_f2fff9d92001bHmjOKS5fuN3KI",
    sessionID: "ses_0d000a6bfffekAuU1lmLPtswxo",
  },
  parts: [
    { type: "step-start", id: "prt_1" },
    { type: "reasoning", text: "pensando...", id: "prt_2" },
    { type: "text", text: "Hola", id: "prt_3" },
    { type: "step-finish", reason: "stop", id: "prt_4" },
  ],
};

// Respuesta real tras un abort a mitad de turno (info.error presente).
const ABORTED_MESSAGE_RESPONSE = {
  info: {
    id: "msg_f30012bf9001ZqwiZ0OG0Tw0Ii",
    sessionID: "ses_0cffef9f8ffeyTSQcz66oMXIF1",
    role: "assistant",
    time: { created: 1783216811001, completed: 1783216813691 },
    error: { name: "MessageAbortedError", data: { message: "Aborted" } },
  },
  parts: [{ type: "step-start", id: "prt_1" }],
};

function startFake(
  requests: Recorded[],
  opts?: {
    onEventStream?: (res: import("node:http").ServerResponse) => void;
    messageResponse?: unknown;
  },
): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", body });
        if (req.url === "/event" && opts?.onEventStream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          opts.onEventStream(res);
          return;
        }
        if (req.url?.startsWith("/session") && req.url.includes("/message")) {
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify(opts?.messageResponse ?? REAL_MESSAGE_RESPONSE));
          return;
        }
        if ((req.url === "/session" || req.url?.startsWith("/session?")) && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              id: "ses_test",
              slug: "misty-engine",
              directory: "C:\\repo",
            }),
          );
          return;
        }
        if (req.url?.endsWith("/abort") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" }).end("true");
          return;
        }
        res.writeHead(200).end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`),
    );
  });
}

describe("splitModel", () => {
  it("divide provider/model por la primera barra", () => {
    expect(splitModel("opencode-go/glm-5.2")).toEqual({ providerID: "opencode-go", modelID: "glm-5.2" });
    expect(splitModel("a/b/c")).toEqual({ providerID: "a", modelID: "b/c" });
  });

  it("lanza si no hay barra", () => {
    expect(() => splitModel("glm")).toThrow(/provider\/model/);
  });
});

describe("OpencodeClient", () => {
  it("createSession manda directory como query param y devuelve el id", async () => {
    const reqs: Recorded[] = [];
    const client = new OpencodeClient(await startFake(reqs));
    const id = await client.createSession("C:\\repo");
    expect(id).toBe("ses_test");
    expect(reqs[0]).toMatchObject({ method: "POST" });
    expect(reqs[0].url).toBe("/session?directory=" + encodeURIComponent("C:\\repo"));
    // El body NO debe llevar directory (va por query string segun el spike).
    expect(JSON.parse(reqs[0].body || "{}")).toEqual({});
  });

  it("createSession sin directory no manda query param", async () => {
    const reqs: Recorded[] = [];
    const client = new OpencodeClient(await startFake(reqs));
    await client.createSession();
    expect(reqs[0].url).toBe("/session");
  });

  it("sendMessage arma parts + model + agent y devuelve el texto final", async () => {
    const reqs: Recorded[] = [];
    const client = new OpencodeClient(await startFake(reqs));
    const result = await client.sendMessage("ses_test", "hola", "opencode/deepseek-v4-flash-free", "build");
    const msg = reqs.find((r) => r.url === "/session/ses_test/message");
    expect(msg).toBeDefined();
    expect(JSON.parse(msg!.body)).toEqual({
      parts: [{ type: "text", text: "hola" }],
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      agent: "build",
    });
    expect(result).toEqual({ text: "Hola" });
  });

  it("sendMessage sin agent no lo incluye en el body", async () => {
    const reqs: Recorded[] = [];
    const client = new OpencodeClient(await startFake(reqs));
    await client.sendMessage("ses_test", "hola", "opencode/deepseek-v4-flash-free");
    const msg = reqs.find((r) => r.url === "/session/ses_test/message");
    expect(JSON.parse(msg!.body)).toEqual({
      parts: [{ type: "text", text: "hola" }],
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
    });
  });

  it("sendMessage lanza si info.error viene en la respuesta (abort/fallo)", async () => {
    const reqs: Recorded[] = [];
    const client = new OpencodeClient(
      await startFake(reqs, { messageResponse: ABORTED_MESSAGE_RESPONSE }),
    );
    await expect(client.sendMessage("ses_test", "hola", "opencode/deepseek-v4-flash-free")).rejects.toThrow(
      /MessageAbortedError|Aborted/,
    );
  });

  it("abort llama a POST /session/:id/abort", async () => {
    const reqs: Recorded[] = [];
    const client = new OpencodeClient(await startFake(reqs));
    await client.abort("ses_test");
    const req = reqs.find((r) => r.url === "/session/ses_test/abort");
    expect(req).toMatchObject({ method: "POST" });
  });

  it("subscribe consume GET /event, entrega eventos parseados y termina al abortar", async () => {
    const reqs: Recorded[] = [];
    const base = await startFake(reqs, {
      onEventStream: (res) => {
        res.write('data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}\n\n');
      },
    });
    const client = new OpencodeClient(base);
    const events: unknown[] = [];
    const ctrl = new AbortController();
    const sub = client.subscribe((e) => {
      events.push(e);
      ctrl.abort();
    }, ctrl.signal);
    await sub;
    expect(events).toEqual([{ type: "session.idle", properties: { sessionID: "ses_test" } }]);
    expect(reqs.some((r) => r.url === "/event")).toBe(true);
  });

  it("subscribe rechaza ante error de red sin abort", async () => {
    const reqs: Recorded[] = [];
    const base = await startFake(reqs, {
      onEventStream: (res) => {
        res.write('data: {"type":"server.heartbeat"}\n\n');
        res.destroy();
      },
    });
    const client = new OpencodeClient(base);
    const ctrl = new AbortController();
    const sub = client.subscribe(() => {}, ctrl.signal);
    await expect(sub).rejects.toThrow();
    expect(reqs.some((r) => r.url === "/event")).toBe(true);
  });

  it("respuesta no-2xx lanza error con status y cuerpo", async () => {
    const reqs: Recorded[] = [];
    server?.close();
    const base = await new Promise<string>((resolve) => {
      server = createServer((_req, res) => res.writeHead(500).end("kaput"));
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`),
      );
    });
    const client = new OpencodeClient(base);
    await expect(client.createSession()).rejects.toThrow(/500.*kaput/s);
    void reqs;
  });
});
