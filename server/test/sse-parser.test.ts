import { describe, expect, it } from "vitest";
import { parseServerEvent, parseSseChunk } from "../src/sse-parser.js";

describe("parseSseChunk", () => {
  it("extrae eventos data: completos y conserva el resto parcial", () => {
    const raw = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"parcial';
    const { events, rest } = parseSseChunk(raw);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('data: {"parcial');
  });

  it("ignora lineas keepalive/comentario", () => {
    const { events, rest } = parseSseChunk(': ping\n\ndata: {"a":1}\n\n');
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe("");
  });

  it("ignora data: no-JSON sin romper el parseo de eventos validos", () => {
    const { events, rest } = parseSseChunk('data: not-json\n\ndata: {"a":1}\n\n');
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe("");
  });
});

// Formas reales capturadas en el spike (Task 1):
// docs/superpowers/specs/2026-07-04-spike-opencode-serve-api.md
// Envelope real: { id, type, properties } — el sessionID vive en properties
// (a veces repetido tambien dentro de properties.part.sessionID).
describe("parseServerEvent", () => {
  it("tool call en estado running -> linea con flecha, tool y resumen del input", () => {
    const evt = {
      id: "evt_f30008806001",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_0cfffa1beffexJAigUd20l44pZ",
        part: {
          id: "prt_f30008806001uVbUcPg6uqFB4r",
          messageID: "msg_f30007f25001s9Vf9Bkjh82GdO",
          sessionID: "ses_0cfffa1beffexJAigUd20l44pZ",
          type: "tool",
          tool: "read",
          callID: "call_00_9tFnJZddbvy0WJNI0l8m5941",
          state: { status: "running", input: { filePath: "src/app.ts" } },
        },
        time: 1783216769281,
      },
    };
    const parsed = parseServerEvent(evt);
    expect(parsed.kind).toBe("tool");
    expect(parsed.sessionId).toBe("ses_0cfffa1beffexJAigUd20l44pZ");
    expect(parsed.line).toBe("→ read src/app.ts");
  });

  it("tool call en estado pending (sin input resuelto) -> kind other, no rompe", () => {
    const evt = {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: {
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: { status: "pending", input: {}, raw: "" },
        },
      },
    };
    expect(parseServerEvent(evt).kind).toBe("other");
  });

  it("message.part.delta con field text -> kind text con el fragmento incremental", () => {
    const evt = {
      id: "evt_f2fffaa00001",
      type: "message.part.delta",
      properties: {
        sessionID: "ses_0d000a6bfffekAuU1lmLPtswxo",
        messageID: "msg_f2fff9d92001bHmjOKS5fuN3KI",
        partID: "prt_f2fffa9f60013PySz2zybbFYUB",
        field: "text",
        delta: "Hola",
      },
    };
    const parsed = parseServerEvent(evt);
    expect(parsed.kind).toBe("text");
    expect(parsed.sessionId).toBe("ses_0d000a6bfffekAuU1lmLPtswxo");
    expect(parsed.text).toBe("Hola");
  });

  it("message.part.delta con field distinto de text (ej. reasoning) -> kind other", () => {
    const evt = {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "reasoning",
        delta: "pensando...",
      },
    };
    expect(parseServerEvent(evt).kind).toBe("other");
  });

  it("message.part.updated con part de tipo text -> kind other (evita duplicar el streaming de delta)", () => {
    // message.part.updated de una part de texto llega vacio al crear la part
    // y con el contenido acumulado completo al finalizar; el streaming real
    // incremental ya lo entrega message.part.delta. Traducirlo tambien a
    // kind:"text" duplicaria/triplicaria el texto en el log.
    const evt = {
      id: "evt_f2fffab35001gkY5ymsr1d0AYX",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_0d000a6bfffekAuU1lmLPtswxo",
        part: {
          id: "prt_f2fffab35001KCnqKtBFBa6UTu",
          messageID: "msg_f2fff9d92001bHmjOKS5fuN3KI",
          sessionID: "ses_0d000a6bfffekAuU1lmLPtswxo",
          type: "text",
          text: "",
          time: { start: 1783216712501 },
        },
        time: 1783216712501,
      },
    };
    expect(parseServerEvent(evt).kind).toBe("other");
  });

  it("session idle -> kind done", () => {
    const evt = {
      id: "evt_f2fffaf690023dzMt4E3nRNswh",
      type: "session.idle",
      properties: { sessionID: "ses_0d000a6bfffekAuU1lmLPtswxo" },
    };
    expect(parseServerEvent(evt)).toMatchObject({
      kind: "done",
      sessionId: "ses_0d000a6bfffekAuU1lmLPtswxo",
    });
  });

  it("session error (abort) -> kind error con mensaje desde error.data.message", () => {
    const evt = {
      id: "evt_f30013447001CgqVQ9je0PInSp",
      type: "session.error",
      properties: {
        sessionID: "ses_0cffef9f8ffeyTSQcz66oMXIF1",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    };
    expect(parseServerEvent(evt)).toMatchObject({
      kind: "error",
      sessionId: "ses_0cffef9f8ffeyTSQcz66oMXIF1",
      errorMessage: "Aborted",
    });
  });

  it("session error sin error.data.message -> usa error.name como fallback", () => {
    const evt = {
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "SomeError" } },
    };
    expect(parseServerEvent(evt)).toMatchObject({
      kind: "error",
      sessionId: "ses_1",
      errorMessage: "SomeError",
    });
  });

  it("eventos de ruido/control observados solo por nombre -> kind other sin romper", () => {
    expect(parseServerEvent({ type: "server.heartbeat" }).kind).toBe("other");
    expect(parseServerEvent({ type: "server.connected" }).kind).toBe("other");
    expect(parseServerEvent({ type: "session.updated", properties: {} }).kind).toBe("other");
    expect(parseServerEvent({ type: "plugin.added" }).kind).toBe("other");
    expect(parseServerEvent(null).kind).toBe("other");
    expect(parseServerEvent(undefined).kind).toBe("other");
    expect(parseServerEvent("not-an-object").kind).toBe("other");
  });
});
