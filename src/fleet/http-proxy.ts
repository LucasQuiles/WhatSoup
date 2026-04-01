import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet:http-proxy');

export interface ProxyResult {
  status: number;
  body: string;
}

/** Forward a request to an instance's health server. */
export async function proxyToInstance(
  healthPort: number,
  path: string,
  method: string,
  body: string | null,
  healthToken: string | null,
  timeoutMs = 5_000,
): Promise<ProxyResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (healthToken) {
      headers['Authorization'] = `Bearer ${healthToken}`;
    }

    const res = await fetch(`http://127.0.0.1:${healthPort}${path}`, {
      method,
      headers,
      body: body && method !== 'GET' ? body : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const responseBody = await res.text();
    return { status: res.status, body: responseBody };
  } catch (err) {
    const message = (err as Error).message ?? 'proxy error';
    log.warn({ healthPort, path, error: message }, 'proxy request failed');
    return { status: 502, body: JSON.stringify({ error: `proxy error: ${message}` }) };
  }
}
