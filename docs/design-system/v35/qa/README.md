# qa/ — visual QA tooling + audit trail (v3.5 console direction A)

Self-contained record of the vision-model QA program behind `10-visual-qa.md`.
Scripts are sanitized: machine-specific paths/hosts are environment variables.

## Layout

- `scripts/` — the QA drivers.
  - `shoot_w4.py` — screenshot pipeline (Playwright, 1440×900 @2x, both themes via
    `data-theme` flip). `MOCKUPS` env overrides the mockups dir (defaults to `../mockups`).
  - `w4_prompt.py` — wave-4 explicit 25-test battery (alignment/consistency/UX/clutter/
    space) + cross-surface G-battery. Single source of truth for all reviewers.
  - `w4_personas.py` / `w4_personas.sh` — wave-4b personas: **sol** (light-theme
    specialist), **luna** (dark-theme specialist), **tera** (cross-surface auditor),
    via codex CLI.
  - `w4_drive.py` — OpenAI / Anthropic API driver (keyring: `service openai`,
    `service anthropic`).
  - `w4_grok.py` — grok driver; reads the xAI OAuth token from the local opencode
    `auth.json` on the machine it runs on (token never leaves the machine).
  - `w4_codex.sh`, `w4_claude.sh` — CLI drivers.
  - `vision_qa.py`, `blind_qa.py` — waves 1–3 drivers (local Ollama host via ssh;
    set `OLLAMA_HOST`; API keys via keyring only).
  - Shared env: `QA_ROOT` (default `~/.cache/soup-v35-qa`) — images in, reports out.
- `evidence/` — the 18 final screenshots (9 surfaces × 2 themes) the wave-4 verdicts
  were rendered against.
- `reports/wave4/` — raw reviewer outputs (gpt-5.4 waves, codex, grok waves, final
  confirmations).
- `reports/wave4/personas/` — sol/tera/luna raw outputs.
- `reports/wave1-3/` — waves 1–3 raw outputs that pass public-repo hygiene. Three
  wave-2 codex reports are **excluded** — they quote pre-wave-4 source lines containing
  real-shaped masked-ID title attributes (the literals later removed from the mockups
  and scrubbed from branch history); they remain in the local QA cache only.

## Method (short)

1. Re-shoot all surfaces fresh (`shoot_w4.py`).
2. Run each reviewer family against the image-only evidence dir (reports archived
   elsewhere to prevent a reviewer recycling its own prior output — contamination
   lesson in `10-visual-qa.md`).
3. Triage every finding: fix, reject with computed evidence (Chromium-measured
   geometry/CSS), or accept with recorded rationale.
4. Re-verify on post-fix images until no undispositioned findings remain.

Anti-artifact rules baked into prompts: sanctioned exceptions enumerated up front
(mode channels, status shapes, masks, journey registers), absolute pixel estimation
banned (relative comparisons only), mandatory element+region citations, confidence
tags, no-praise framing.
