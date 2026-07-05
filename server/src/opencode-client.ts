import { parseSseChunk } from "./sse-parser.js";

/**
 * Cliente HTTP+SSE para `opencode serve`.
 *
 * Endpoints y shapes confirmados contra el spike (Task 1):
 * docs/superpowers/specs/2026-07-04-spike-opencode-serve-api.md
 *
 * Desviaciones clave respecto al plan original:
 * - `directory` va como query param en `POST /session`, no en el body.
 * - `POST /session/:id/message` es BLOQUEANTE: retorna el mensaje completo
 *   (info + parts) al terminar el turno (exito, error o abort), no hace
 *   falta esperar al SSE para saber el resultado final.
 * - El resultado de un abort/error de modelo llega como HTTP 200 con
 *   `info.error` poblado (ej. `{name: "MessageAbortedError", data:{message}}`),
 *   no como un error HTTP.
 */

export function splitModel(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx <= 0) throw new Error(`Modelo "${model}" invalido: se espera formato provider/model`);
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

interface MessagePart {
  type?: string;
  text?: string;
}

interface MessageInfo {
  error?: { name?: string; data?: { message?: string } };
}

interface MessageResponse {
  info?: MessageInfo;
  parts?: MessagePart[];
}

/** Resultado de un turno completado via `sendMessage`. Consumido por Task 9 (tools.ts). */
export interface SendMessageResult {
  text: string;
}

function extractText(parts: MessagePart[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

function describeInfoError(error: NonNullable<MessageInfo["error"]>): string {
  return error.data?.message ? `${error.name ?? "Error"}: ${error.data.message}` : (error.name ?? "error desconocido de opencode");
}

export class OpencodeClient {
  constructor(private readonly baseUrl: string) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode serve respondio ${res.status} en ${path}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  async createSession(directory?: string): Promise<string> {
    const path = directory ? `/session?directory=${encodeURIComponent(directory)}` : "/session";
    const data = (await this.post(path, {})) as { id?: string };
    if (!data.id) throw new Error("POST /session no devolvio un id de sesion");
    return data.id;
  }

  async sendMessage(sessionId: string, text: string, model: string, agent?: string): Promise<SendMessageResult> {
    const data = (await this.post(`/session/${sessionId}/message`, {
      parts: [{ type: "text", text }],
      model: splitModel(model),
      ...(agent ? { agent } : {}),
    })) as MessageResponse;

    if (data.info?.error) {
      throw new Error(describeInfoError(data.info.error));
    }

    return { text: extractText(data.parts) };
  }

  async abort(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/abort`, {});
  }

  async subscribe(onEvent: (evt: unknown) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(this.baseUrl + "/event", { signal });
    if (!res.ok || !res.body) throw new Error(`GET /event respondio ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const evt of events) onEvent(evt);
      }
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }
}
