---
description: Limpiar worktrees de jobs delegados terminados
argument-hint: [jobId]
---

ANTES de limpiar: lista con la tool `status` qué worktrees se van a eliminar y pídeme confirmación explícita. Solo tras mi confirmación llama a la tool MCP `cleanup` del plugin opencode-delegate (con $ARGUMENTS como jobId si lo di; sin argumentos limpia todos los terminados).
