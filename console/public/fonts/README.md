# Console Fonts — Provenance

Self-hosted woff2 files for the SOUP v3 identity typography — the showcase identity triad:
**Bricolage Grotesque** (display) + **Hanken Grotesk** (body) + **IBM Plex Mono** (data/nameplate).

## Sources

### Hanken Grotesk (active — body, `--font-sans`)
- **Package:** `@fontsource/hanken-grotesk` v5 (https://www.npmjs.com/package/@fontsource/hanken-grotesk)
- **Upstream:** https://github.com/hanken-design/hanken-grotesk
- **License:** SIL Open Font License 1.1. Copyright the Hanken Grotesk Project Authors.
- **Weights:** 400/500/600 (latin, normal) — matches the active `--type-*` weight set.

### IBM Plex Mono (active — data lanes + nameplate, `--font-mono`)
- **Package:** `@fontsource/ibm-plex-mono` v5 (https://www.npmjs.com/package/@fontsource/ibm-plex-mono)
- **Upstream:** https://github.com/IBM/plex
- **License:** SIL Open Font License 1.1. Copyright 2017 IBM Corp.
- **Weights:** 400/500/600 (latin, normal). Includes tabular figures for data lanes.

### Bricolage Grotesque (active — display tier + Landing hero, `--font-display`)
- **Package:** `@fontsource/bricolage-grotesque` v5 (https://www.npmjs.com/package/@fontsource/bricolage-grotesque)
- **Upstream:** https://github.com/ateliertriay/bricolage
- **License:** SIL Open Font License 1.1. Copyright the Bricolage Grotesque Project Authors.
- **Weights:** 600/700/800 (latin, normal) — editorial display read; falls back to Hanken.

## Weights shipped

No italics. Body/mono (Hanken Grotesk, IBM Plex Mono): 400/500/600, matching the
`--type-*` ramp. Display (Bricolage Grotesque): 600/700/800 for the editorial display read.

## Files and sha256

| File | Weight | sha256 |
|---|---|---|
| HankenGrotesk-400.woff2 | 400 | 787b3fdd0b7e6d59ae7ce14ce7a41d1a44616584b4c919b527da951972d5d87d |
| HankenGrotesk-500.woff2 | 500 | 31f666af7bff625900c46aa34a05d8620482ba2db37db7b63749b693ab0c72ec |
| HankenGrotesk-600.woff2 | 600 | 58f23b7ae3e13b21a4dca4c05360be87b3531d60fc1cbff89732cac8fb3019ae |
| IBMPlexMono-400.woff2 | 400 | 08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7 |
| IBMPlexMono-500.woff2 | 500 | 01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22 |
| IBMPlexMono-600.woff2 | 600 | 0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83 |
| BricolageGrotesque-600.woff2 | 600 | b34fc8c1ef0ac8798455ac2979eae4b4f90f0d327e3584d1032fa77a8a9a66ca |
| BricolageGrotesque-700.woff2 | 700 | 4c373ce3c1cca41c864eb3e27c059a59fc6310547ab9c9b6cd780d387ba24206 |
| BricolageGrotesque-800.woff2 | 800 | 3e1b5f0a56ee995b7c1445bc54e6ec98c5dffb585ef5c4baf86731cf68e27c61 |

## Verification

```
shasum -a 256 console/public/fonts/*.woff2
```

Expected output matches the table above.
