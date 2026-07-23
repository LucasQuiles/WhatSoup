#!/usr/bin/env python3
"""Wave-4 adversarial QA driver — grok-4.5 via xAI OAuth (runs on the xAI OAuth host).
Reads the OAuth access token from opencode auth.json; token never leaves the machine."""
import base64, json, os, sys, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from w4_prompt import surface_prompt, global_prompt

IMG = os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/w4-img/'
OUT = os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/w4-reports/'
S = ['fleet', 'hatch', 'agents', 'skills-hub', 'dream-lab', 'inbox', 'deployments', 'settings', 'splash']
BATCHES = [
    [f'{s}-{t}.png' for s in S[0:3] for t in ('dark', 'light')],
    [f'{s}-{t}.png' for s in S[3:6] for t in ('dark', 'light')],
    [f'{s}-{t}.png' for s in S[6:9] for t in ('dark', 'light')],
]
GLOBAL = [f'{s}-dark.png' for s in S]

def b64(name):
    return base64.b64encode(open(IMG + name, 'rb').read()).decode()

def token():
    d = json.load(open(os.path.expanduser('~/.local/share/opencode/auth.json')))
    return d['xai']['access']

def grok_call(prompt, images):
    content = [{"type": "text", "text": prompt}]
    content += [{"type": "image_url", "image_url": {"url": f'data:image/png;base64,{b64(i)}'}} for i in images]
    body = json.dumps({"model": "grok-4.5", "messages": [{"role": "user", "content": content}],
                       "max_completion_tokens": 6000}).encode()
    req = urllib.request.Request('https://api.x.ai/v1/chat/completions', data=body,
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': f'Bearer {token()}'})
    r = json.load(urllib.request.urlopen(req, timeout=600))
    return r['choices'][0]['message']['content']

os.makedirs(OUT, exist_ok=True)
for n, batch in enumerate(BATCHES, 1):
    print(f'[grok] batch {n}', flush=True)
    text = grok_call(surface_prompt(batch), batch)
    open(f'{OUT}grok-{n}.txt', 'w').write(text)
    print(f'[grok] batch {n}: {len(text)} chars', flush=True)
print('[grok] global batch', flush=True)
text = grok_call(global_prompt(GLOBAL), GLOBAL)
open(f'{OUT}grok-global.txt', 'w').write(text)
print(f'[grok] global: {len(text)} chars', flush=True)
print('[grok] DONE', flush=True)
