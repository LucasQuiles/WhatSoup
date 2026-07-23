#!/usr/bin/env python3
"""Wave-4 fresh screenshots: all mockup surfaces x both themes, 1440x900."""
import asyncio, os, sys
from playwright.async_api import async_playwright

SRC = os.environ.get('MOCKUPS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'mockups'))
OUT = os.environ.get('QA_ROOT', os.path.expanduser('~/.cache/soup-v35-qa')) + '/w4'
SURFACES = ['fleet', 'hatch', 'agents', 'skills-hub', 'dream-lab', 'inbox', 'deployments', 'settings', 'splash']
THEMES = ['dark', 'light']

async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel='chrome')
        page = await browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=2)
        for s in SURFACES:
            await page.goto(f'file://{SRC}/{s}.html')
            await page.wait_for_timeout(400)
            for t in THEMES:
                await page.evaluate(f'document.documentElement.setAttribute("data-theme", "{t}")')
                await page.wait_for_timeout(250)
                await page.screenshot(path=f'{OUT}/{s}-{t}.png')
                print(f'{s}-{t}.png')
        await browser.close()

asyncio.run(main())
