# Console Fonts — Provenance

Self-hosted woff2 files for the SOUP v3 identity typography. The active triad is the
showcase identity set: **Hanken Grotesk** (body) + **IBM Plex Mono** (data/nameplate);
**Bricolage Grotesque** (display) arrives with the display tier. **Geist** is retained as
an inert @font-face during the cutover and is removed once nothing references it.

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

### Geist (inert — retained until removal)
- **Repository:** https://github.com/vercel/geist-font
- **Release tag:** v1.7.2 — **License:** SIL Open Font License 1.1
  Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)
- No production token references Geist after the Hanken/IBM Plex swap; the @font-face
  declarations are kept inert for rollback safety and removed in a follow-up.

## Weights shipped

400/500/600 only (no italics), matching the `--type-*` weight set.

## Files and sha256

| File | Weight | sha256 |
|---|---|---|
| HankenGrotesk-400.woff2 | 400 | 787b3fdd0b7e6d59ae7ce14ce7a41d1a44616584b4c919b527da951972d5d87d |
| HankenGrotesk-500.woff2 | 500 | 31f666af7bff625900c46aa34a05d8620482ba2db37db7b63749b693ab0c72ec |
| HankenGrotesk-600.woff2 | 600 | 58f23b7ae3e13b21a4dca4c05360be87b3531d60fc1cbff89732cac8fb3019ae |
| IBMPlexMono-400.woff2 | 400 | 08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7 |
| IBMPlexMono-500.woff2 | 500 | 01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22 |
| IBMPlexMono-600.woff2 | 600 | 0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83 |
| Geist-Regular.woff2 | 400 | d8bce822db092746889bcf3f57350b41f53708b025458fe7af30729ec4ce0df2 |
| Geist-Medium.woff2 | 500 | b0a0867cda44efef4529a4b13ce37fd9fd6e1597708615287542a51bc7452ab4 |
| Geist-SemiBold.woff2 | 600 | b1e6a1dd2122485d0a1f3a8d30a45443aa9453224f83018bec35f8266bc77915 |
| GeistMono-Regular.woff2 | 400 | e4507fb4fb5f832fbbb6c06aea4206274ba3083007f23fa8cbc0e87a10acf95b |
| GeistMono-Medium.woff2 | 500 | 85b99e603f84a47dc8118b5af058ad8f387d7c507a00faeef1b5b60eb371e844 |
| GeistMono-SemiBold.woff2 | 600 | 8416445afd947018ffeb31844da808bd7f4356f5dc7d73a084659c32eae26548 |

## Verification

```
shasum -a 256 console/public/fonts/*.woff2
```

Expected output matches the table above.
