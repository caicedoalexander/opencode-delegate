import { z } from "zod";

/**
 * Schema de `timeout_minutes` para la tool `delegate` (borde MCP).
 *
 * Extraido de `index.ts` para poder testearlo sin importar el bootstrap
 * completo del server (que conecta un `StdioServerTransport` al importarse).
 *
 * Rango acotado a (0, 1440]: 0 o negativo dispara el timer de abort de
 * inmediato; valores enormes desbordan el limite de `setTimeout` de Node
 * (~24.8 dias, entero de 32 bits con signo en ms).
 */
export const timeoutMinutesSchema = z.number().positive().max(1440).optional();
