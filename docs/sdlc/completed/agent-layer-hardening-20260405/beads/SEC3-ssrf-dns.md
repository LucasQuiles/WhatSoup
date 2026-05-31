# SEC3: SSRF Guard DNS Rebind Bypass in Link Preview

**Severity:** High
**Source:** L audit finding H5
**Files:** `src/runtimes/chat/media/links.ts:12-28`

## Problem

The link preview feature fetches URLs to generate previews. There is a guard that checks for private IP ranges (127.0.0.1, 10.x, 192.168.x, etc.) but it operates on the URL hostname string, not the resolved IP address. A DNS rebind attack using a public domain that resolves to 127.0.0.1 (e.g., `localtest.me`, `spoofed.burpcollaborator.net`) bypasses this guard entirely.

## Fix

1. Resolve the hostname to IP address(es) using `dns.resolve4()` BEFORE making the HTTP request
2. Check ALL resolved IPs against the private range blocklist
3. Block link previews for any URL that resolves to a private/loopback/link-local address
4. Also block IPv6 loopback (::1) and link-local (fe80::) addresses

## Verification

- Unit test: URL resolving to 127.0.0.1 → blocked
- Unit test: URL resolving to 10.0.0.1 → blocked
- Unit test: URL resolving to public IP → allowed
- Unit test: URL with no DNS resolution → blocked (fail-closed)
