#!/usr/bin/env python3
"""Vision QA driver — batches mockup screenshots through a local Ollama vision host (set OLLAMA_HOST)."""
import base64, json, os, subprocess, sys

PROMPT = """You are a senior product designer doing visual QA on mockup screenshots for "SOUP", a multi-channel agent-fleet console. Examine each attached image carefully.

LOCKED DESIGN LANGUAGE (verify conformance):
- Dark theme "gentle warm": deep warm-brown surfaces (near-black with warm tint), cream text
- Single electric-blue accent for actions/focus/selection ONLY; mode colors teal(passive)/cyan(chat)/violet(agent); status green/amber/red
- Status must be SHAPE-coded (disc/diamond/square/outline), never color-only
- Channel glyphs: filled monochrome silhouettes with small state dots
- Avatars: initials on muted hue fills, white initials
- Console register: small radii, dense operator feel; Journey surfaces (hatch/splash): larger radii, spacious
- NO gradients (except one sanctioned radial glow at the hatch ceremony), no glow elsewhere, no mascots
- Nameplate: small teal square tick + SOUP wordmark with blue "U"

EVALUATE each image (cite surface + element):
1. BROKEN: overflow, clipping, misalignment, overlap, broken icons, truncated text, inconsistent paddings — anything looking like a bug
2. LEGIBILITY: anything looking too dim or too loud (visual suspicion only)
3. COLOR DISCIPLINE: hues outside the locked set; color-only meaning
4. HIERARCHY/DENSITY: eye-landing order right? too dense/empty?
5. FEEL: reads "warm, calm, professional, premium"? what feels off (muddy/cold/generic)?
6. Top-3 craft improvements per surface

Output per image: [BROKEN] list, [POLISH] list, craft score 1-10. Be critical, no praise. If nothing broken, say "none"."""

def batch(images, out_path):
    payload = {"model": "qwen2.5vl:72b", "prompt": PROMPT + "\n\nImages in order: " + ", ".join(images),
               "images": [base64.b64encode(open(fos.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/v35/{i}', 'rb').read()).decode() for i in images],
               "stream": False}
    os.makedirs(os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/tmp', exist_ok=True)
    with open(os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/tmp/vl-payload.json', 'w') as f:
        json.dump(payload, f)
    r = subprocess.run(['ssh', '-o', 'ConnectTimeout=8', os.environ.get('OLLAMA_HOST', 'localhost'),
                        'curl -s -X POST http://localhost:11434/api/generate -d @/dev/stdin --max-time 900'],
                       stdin=open(os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/tmp/vl-payload.json', 'rb'), capture_output=True, timeout=960)
    resp = json.loads(r.stdout).get('response', f'ERROR: {r.stdout[:300]} {r.stderr[:300]}')
    open(out_path, 'w').write(resp)
    print(f'{out_path}: {len(resp)} chars')

batches = sys.argv[1:]
for i, b in enumerate(batches):
    imgs = b.split(',')
    batch(imgs, fos.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/v35/report-{i+1}.txt')
