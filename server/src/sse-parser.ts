/**
 * Parser de eventos de `opencode serve` -> lineas de log legibles.
 *
 * Formas de evento verificadas contra el spike (Task 1):
 * docs/superpowers/specs/2026-07-04-spike-opencode-serve-api.md
 *
 * Envelope real del stream SSE global (`GET /event`):
 *   { id: string, type: string, properties: {...} }
 * El `sessionID` vive dentro de `properties` (a veces repetido tambien en
 * `properties.part.sessionID`, pero `properties.sessionID` es la fuente mas
 * confiable porque esta presente en todos los tipos de evento capturados).
 */

export interface ParsedEvent {
  kind: "tool" | "text" | "done" | "error" | "other";
  line?: string;
  sessionId?: string;
  text?: string;
  errorMessage?: string;
}

/**
 * Parser incremental del wire format SSE: cada evento llega como una linea
 * `data: {...}` seguida de una linea en blanco. Devuelve los JSONs completos
 * ya parseados y el resto del buffer sin consumir (frame parcial en curso).
 *
 * Lineas que no empiezan con "data: " (comentarios/keepalive tipo ": ping",
 * o campos `event:`/`id:` de la spec SSE, no observados en la practica contra
 * opencode pero tolerados por robustez) se ignoran.
 */
export function parseSseChunk(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // data no-JSON: se ignora deliberadamente (unico error silenciado a
        // proposito); el log crudo del stream ya queda capturado aguas arriba.
      }
    }
  }
  return { events, rest };
}

/** Resume el input de una tool call en una sola linea de log. */
function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Claves de input mas comunes observadas en el spike (filePath, command...).
    for (const key of ["filePath", "path", "command", "pattern", "url", "description"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return "";
}

interface ToolPart {
  type?: string;
  tool?: string;
  state?: { status?: string; input?: unknown };
}

interface TextPart {
  type?: string;
  text?: string;
}

function parseMessagePartUpdated(properties: Record<string, unknown>): ParsedEvent {
  const part = properties.part as (ToolPart & TextPart) | undefined;
  const sessionId = (properties.sessionID as string | undefined) ?? undefined;
  if (!part) return { kind: "other" };

  if (part.type === "tool" && part.state?.status === "running") {
    const summary = summarizeInput(part.state.input);
    return {
      kind: "tool",
      sessionId,
      line: `→ ${part.tool ?? "tool"}${summary ? " " + summary : ""}`,
    };
  }

  // NOTA (spike, desviacion #7): message.part.updated de una part de texto
  // llega vacia al crearse y con el contenido acumulado completo al
  // finalizar. El streaming token a token real llega via message.part.delta.
  // No se traduce aqui a kind:"text" para no duplicar/triplicar el texto en
  // el log: message.part.delta es la unica fuente de kind:"text".
  return { kind: "other" };
}

function parseMessagePartDelta(properties: Record<string, unknown>): ParsedEvent {
  const sessionId = properties.sessionID as string | undefined;
  if (properties.field === "text" && typeof properties.delta === "string") {
    return { kind: "text", sessionId, text: properties.delta };
  }
  // Otros campos (ej. "reasoning") no se traducen a lineas de log por ahora.
  return { kind: "other" };
}

function parseSessionError(properties: Record<string, unknown>): ParsedEvent {
  const sessionId = properties.sessionID as string | undefined;
  const error = properties.error as { name?: string; message?: string; data?: { message?: string } } | undefined;
  const errorMessage = error?.data?.message ?? error?.message ?? error?.name ?? "error desconocido de opencode";
  return { kind: "error", sessionId, errorMessage };
}

/** Traduce un evento JSON del stream global de opencode (`GET /event`) a un ParsedEvent. */
export function parseServerEvent(evt: unknown): ParsedEvent {
  if (!evt || typeof evt !== "object") return { kind: "other" };
  const e = evt as { type?: string; properties?: Record<string, unknown> };
  const props = e.properties ?? {};

  switch (e.type) {
    case "message.part.updated":
      return parseMessagePartUpdated(props);
    case "message.part.delta":
      return parseMessagePartDelta(props);
    case "session.idle":
      return { kind: "done", sessionId: props.sessionID as string | undefined };
    case "session.error":
      return parseSessionError(props);
    default:
      // Incluye ruido/control observado solo por nombre en el spike
      // (server.heartbeat, server.connected, session.updated, plugin.added,
      // catalog.updated, etc.) sin shape capturado: se ignora como "other".
      return { kind: "other" };
  }
}
