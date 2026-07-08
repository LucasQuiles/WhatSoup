// Clean dedicated Chrome relink driver for ad-bot — runs ON mini10, headed, in Aron's GUI session.
// Reads fleet token at runtime from fleet-tokens.json (never logged).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONSOLE = 'http://127.0.0.1:9099';
const tokPath = join(homedir(), '.config/whatsoup/fleet-tokens.json');
const token = JSON.parse(readFileSync(tokPath, 'utf8')).active;
if (!/^[0-9a-f]{64}$/.test(token)) { console.error('BAD_TOKEN'); process.exit(3); }

const profile = '/tmp/wa-relink-profile';
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  channel: 'chrome',
  viewport: null,
  args: ['--new-window', '--window-size=1120,960'],
});
const page = ctx.pages()[0] || await ctx.newPage();

await page.goto(CONSOLE, { waitUntil: 'domcontentloaded' });
console.log('LOADED');

// Unlock console with the fleet token
const tok = page.getByLabel('fleet token');
await tok.waitFor({ timeout: 20000 });
await tok.fill(token);
await page.getByRole('button', { name: /^unlock/i }).click();
console.log('UNLOCK_SUBMITTED');

// Click Re-link (ad-bot is the only unlinked line)
const relink = page.getByRole('button', { name: /re-?link/i });
await relink.first().waitFor({ timeout: 30000 });
await relink.first().click();
console.log('RELINK_CLICKED');

// QR dialog should appear
await page.getByRole('dialog').waitFor({ timeout: 30000 }).catch(() => {});
console.log('QR_READY :: Aron -> WhatsApp > Settings > Linked Devices > Link a device > scan on-screen QR');

// Stay alive up to 8 min; treat dialog disappearance as likely link success
const deadline = Date.now() + 8 * 60 * 1000;
let linked = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(4000);
  const dlg = await page.getByRole('dialog').count().catch(() => 1);
  if (dlg === 0) { linked = true; break; }
}
console.log(linked ? 'DIALOG_CLOSED_LIKELY_LINKED' : 'TIMEOUT_NO_LINK');
await page.waitForTimeout(1500);
await ctx.close();
process.exit(linked ? 0 : 4);
