# #2192 env-read migration — slice-3/slice-4 disposition records

These are the design records that the per-file reasons in
`tests/scripts/env-read-allowlist.test.ts` cite as "#2192 slice 3c" and
"#2192 s4 verdict". They were authored by the #2192 design delegate,
harvested and lead-verified 2026-08-15, and are landed here so every
citation in the allowlist resolves inside the repo.

- `s3-design.md` — slice-3 (outbox/alert family) dispositions; §5c holds the
  per-var keep-reasons stamped on `src/lib/bot-errors-outbox.ts`,
  `src/lib/emit-alert.ts`, and `src/lib/recovery-authority-store.ts`.
- `s4-design.md` — slice-4 dispositions; §6 holds the keep-env verdicts for
  arc-binding-health, platform (WHATSOUP_NODE), model-advisor
  (CLAUDE_CONFIG_DIR), runtime-turn-result-handler, faster-whisper,
  whisper-cpp, and auth (WHATSOUP_PAIR_NUMBER); §9 "Car 3 (doc-only)"
  prescribes the allowlist reason rewrites that replaced the older
  "typed-field candidate" text. Where §6 and the earlier slice-0 scout
  disagree, §6 is the later, deeper adjudication and supersedes the scout.

Provenance pin (sha256). `s3-design.md` is landed byte-identical to the
durable delegate copy. `s4-design.md` differs from the delegate original by
exactly one publication-hygiene edit (a home-relative reviewer path on the
"Format" line reworded); both hashes are pinned:

- `s3-design.md` (landed == delegate original)
  dc556f35b2d833551c779d3ba9d007885bc5325aa3c939aa22a1220670229fd4
- `s4-design.md` landed
  4cf33b1a475a448d4244495cab30c21a8bf149605c2f971f04804a7803c11c33
- `s4-design.md` delegate original
  ef69e399e0ff864b6b8478d80a282a34e0e64d94bbbc46ab083d1ba1deaf16fa
