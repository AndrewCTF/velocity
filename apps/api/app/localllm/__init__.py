"""Local model manager — curated Unsloth GGUF catalog, hardware-aware presets,
on-disk install registry, and the llama.cpp/vLLM/Ollama engine switch.

See ``docs/decisions.md`` (local-llm design, 2026-07-11) for the approved
contract. Submodules:

- ``catalog``  — the 7-tier curated model list (data only).
- ``hardware`` — GPU/RAM/disk detection + speed/medium/quality preset logic.
- ``manager``  — models root, install registry, download jobs, active/hot
                 roles, delete-with-containment.
- ``binary``   — llama-server resolution + managed release install.
- ``state``    — process-global engine override (mirrors ``app.llm.prefer_local``).
"""

from __future__ import annotations
