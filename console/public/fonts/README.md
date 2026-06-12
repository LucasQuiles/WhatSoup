# Geist Font — Provenance

Self-hosted woff2 files for DD-4 (typography.md §1, design-debt-register.md DD-4).

## Source

- **Repository:** https://github.com/vercel/geist-font
- **Release tag:** v1.7.2
- **Release URL:** https://github.com/vercel/geist-font/releases/tag/v1.7.2
- **Archive downloaded:** geist-font-v1.7.2.zip
- **License:** SIL Open Font License 1.1 (OFL.txt in release archive)
  Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)

## Weights shipped

Weights 400/500/600 only — matching typography.md §1 + §7 and the active CDN import (wght@400;500;600).
No italic variants (typography spec §7: "No italic except the typing indicator" — the typing indicator
does not use Geist).

## Files and sha256

| File | Weight | sha256 |
|---|---|---|
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
