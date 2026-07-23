#!/usr/bin/env python3
"""Double-blind adversarial vision QA — Gemini (blind) + OpenAI (adversarial, spec-armed)."""
import base64, json, os, subprocess, sys, urllib.request

DIR = os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/v35/blind/'
DARK = ['fleet','hatch','agents','skills-hub','dream-lab','inbox','deployments','settings','splash']
LIGHT = ['fleet','hatch','splash']

def b64(name):
    return base64.b64encode(open(DIR + name, 'rb').read()).decode()

def gemini_key():
    for svc, usr in (('gemini', None), ('google', None)):
        try:
            k = subprocess.run(['secret-tool', 'lookup', 'service', svc], capture_output=True, text=True).stdout.strip()
            if k: return k
        except Exception: pass
    return None

def openai_key():
    return subprocess.run(['secret-tool', 'lookup', 'service', 'openai'], capture_output=True, text=True).stdout.strip()

BLIND_PROMPT = """You are an adversarial UI auditor paid per defect found. These are screenshots of a dark-themed operations console product (and one light variant set if included). Assume defects exist.

For EACH image, list EVERY visual defect you can find: overflow, clipping, misalignment, overlapping elements, truncation that loses information, unreadable or nearly-unreadable text, contrast that looks too low, inconsistent spacing/paddings, broken or missing icons, elements that look unfinished or out of place. For each defect give: surface area (top/left/center/right/bottom + element), one-line description, severity (high/med/low).

Rules: NO praise. NO summaries of what works. NO design suggestions beyond fixing defects. If a surface truly has no defects, write "none found" for it. End with a per-image defect count."""

ARMED_PROMPT = """You are an adversarial design-system conformance auditor. You are given UI screenshots plus the system's rules. Assume violations exist; your job is to FIND them.

RULES:
1. Single action accent (one blue) for actions/focus/selection ONLY. Status colors: green/amber/red. Mode colors: teal/cyan/violet. No other chromatic meaning.
2. Status must be SHAPE-coded (disc/diamond/square/outline) — color alone is a violation.
3. Channel glyphs must be monochrome filled silhouettes.
4. Text must remain readable: nothing below 11px, no low-contrast muted text for essential content.
5. No gradients or glow effects anywhere EXCEPT one radial glow at the hatch ceremony moment.
6. Identifiers may be masked (e.g. phone numbers) but must keep useful prefix+suffix.
7. Every interactive element must look interactive (button affordance).

For EACH image: list every RULE VIOLATION with location + rule number + severity, then list any other visual defect (same rigor as a bug hunt). NO praise. If clean for a surface, write "no violations found". End with per-image violation counts."""

def gemma_call(images, out_path):
    payload = {"model": "gemma3:27b", "prompt": BLIND_PROMPT + "\n\nImages in order: " + ", ".join(images),
               "images": [b64(i) for i in images], "stream": False}
    os.makedirs(os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/tmp', exist_ok=True)
    with open(os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/tmp/blind-payload.json', 'w') as f:
        json.dump(payload, f)
    r = subprocess.run(['ssh', '-o', 'ConnectTimeout=8', os.environ.get('OLLAMA_HOST', 'localhost'),
                        'curl -s -X POST http://localhost:11434/api/generate -d @/dev/stdin --max-time 900'],
                       stdin=open(os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/tmp/blind-payload.json', 'rb'), capture_output=True, timeout=960)
    text = json.loads(r.stdout).get('response', f'ERROR: {r.stdout[:200]} {r.stderr[:200]}')
    open(out_path, 'w').write(text)
    print(f'gemma {out_path}: {len(text)} chars')

def openai_call(images, out_path):
    key = openai_key()
    content = [{"type": "text", "text": ARMED_PROMPT + "\n\nImages in order: " + ", ".join(images)}]
    content += [{"type": "image_url", "image_url": {"url": f'data:image/png;base64,{b64(i)}'}} for i in images]
    body = json.dumps({"model": "gpt-5.4", "messages": [{"role": "user", "content": content}], "max_completion_tokens": 3000}).encode()
    req = urllib.request.Request('https://api.openai.com/v1/chat/completions', data=body,
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
    resp = json.load(urllib.request.urlopen(req, timeout=300))
    text = resp['choices'][0]['message']['content']
    open(out_path, 'w').write(text)
    print(f'openai {out_path}: {len(text)} chars')

which = sys.argv[1]
if which == 'gemma':
    for n, b in enumerate([DARK[0:3], DARK[3:6], DARK[6:9], LIGHT]):
        names = [f'{s}-dark.png' for s in b] if n < 3 else [f'{s}-light.png' for s in b]
        gemma_call(names, f'{DIR}gemma-{n+1}.txt')
else:
    for n, b in enumerate([DARK[0:3], DARK[3:6], DARK[6:9]]):
        openai_call([f'{s}-dark.png' for s in b], f'{DIR}openai-{n+1}.txt')
