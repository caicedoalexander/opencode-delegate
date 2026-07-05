---
description: Ver o configurar los modelos de opencode-delegate
argument-hint: [set]
---

Gestiona la configuración de modelos del plugin opencode-delegate: $ARGUMENTS

Rutas de config (merge parcial; sin archivos aplican los defaults compilados
del server):

- Usuario: `~/.config/opencode-delegate/config.json`
- Proyecto (gana sobre usuario): `.opencode-delegate/config.json`

Estructura: `{ "defaultModel": "provider/model", "tiers": { "light": "...",
"standard": "...", "heavy": "..." }, "serve": { "port": 4573,
"reuseExisting": true } }`.

**Si $ARGUMENTS está vacío (modo ver):** lee ambos archivos (si existen) y
muéstrame la configuración efectiva resultante en una tabla — cada valor con
su origen (default | usuario | proyecto). No modifiques nada.

**Si $ARGUMENTS es `set` (modo configurar):**

1. Ejecuta `opencode models` para listar los modelos disponibles.
2. Pregúntame (con opciones concretas de esa lista) qué modelo quiero para
   cada tier — `light` (barato/mecánico), `standard` (default), `heavy`
   (razonamiento) — y cuál como `defaultModel`. Sugiere modelos free para
   `light` si los hay. Permíteme dejar tiers con su valor actual.
3. Pregúntame el destino: config de usuario (todos mis proyectos) o de este
   proyecto.
4. Escribe el JSON solo con las claves que cambié respecto a la config
   efectiva actual, preservando las claves ya presentes en ese archivo.
   Valida que sea JSON válido antes de guardar.
5. Muéstrame la config efectiva resultante y recuérdame que el server MCP la
   lee al arrancar: un cambio aplica en la próxima sesión (o tras
   `/reload-plugins`).
