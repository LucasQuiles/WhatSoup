#!/usr/bin/env python3
"""Wave-4 adversarial QA driver — OpenAI (gpt-5.4) and Anthropic (claude-opus-4-8).
Usage: w4_drive.py openai|anthropic
Reports land in ${QA_ROOT}/reports-w4/ (isolated from images)."""
import base64, json, os, subprocess, sys, urllib.request

sys.path.insert(0, os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')))
from w4_prompt import surface_prompt, global_prompt

IMG = os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/w4/'
OUT = os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/reports-w4/'
S = ['fleet', 'hatch', 'agents', 'skills-hub', 'dream-lab', 'inbox', 'deployments', 'settings', 'splash']

BATCHES = [
    [f'{s}-{t}.png' for s in S[0:3] for t in ('dark', 'light')],
    [f'{s}-{t}.png' for s in S[3:6] for t in ('dark', 'light')],
    [f'{s}-{t}.png' for s in S[6:9] for t in ('dark', 'light')],
]
GLOBAL = [f'{s}-dark.png' for s in S]

def b64(name):
    return base64.b64encode(open(IMG + name, 'rb').read()).decode()

def key(service):
    return subprocess.run(['secret-tool', 'lookup', 'service', service],
                          capture_output=True, text=True).stdout.strip()

def post(url, body, headers, timeout=600):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def openai_call(prompt, images):
    content = [{"type": "text", "text": prompt}]
    content += [{"type": "image_url", "image_url": {"url": f'data:image/png;base64,{b64(i)}'}} for i in images]
    r = post('https://api.openai.com/v1/chat/completions',
             {"model": "gpt-5.4", "messages": [{"role": "user", "content": content}], "max_completion_tokens": 6000},
             {'Content-Type': 'application/json', 'Authorization': f'Bearer {key("openai")}'})
    return r['choices'][0]['message']['content']

def anthropic_call(prompt, images):
    content = [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64(i)}} for i in images]
    content.append({"type": "text", "text": prompt})
    r = post('https://api.anthropic.com/v1/messages',
             {"model": "claude-opus-4-8", "max_tokens": 8000, "messages": [{"role": "user", "content": content}]},
             {'Content-Type': 'application/json', 'x-api-key': key("anthropic"), 'anthropic-version': '2023-06-01'})
    return ''.join(b['text'] for b in r['content'] if b['type'] == 'text')

which = sys.argv[1]
call = {'openai': openai_call, 'anthropic': anthropic_call}[which]
os.makedirs(OUT, exist_ok=True)

for n, batch in enumerate(BATCHES, 1):
    tag = ', '.join(batch)
    print(f'[{which}] batch {n}: {tag}', flush=True)
    text = call(surface_prompt(batch), batch)
    open(f'{OUT}{which}-{n}.txt', 'w').write(text)
    print(f'[{which}] batch {n}: {len(text)} chars', flush=True)

print(f'[{which}] global batch (9 dark)', flush=True)
text = call(global_prompt(GLOBAL), GLOBAL)
open(f'{OUT}{which}-global.txt', 'w').write(text)
print(f'[{which}] global: {len(text)} chars', flush=True)
print(f'[{which}] DONE', flush=True)
