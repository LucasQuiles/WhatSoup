import { readFleetTokenForDevProxy } from './vite.fleet-token.ts';

interface ProxyRequest {
  setHeader(name: string, value: string): void;
}

interface ProxyServer {
  on(event: 'proxyReq', listener: (proxyReq: ProxyRequest) => void): void;
}

export function attachFleetTokenAuth(
  proxy: ProxyServer,
  readToken: () => string = readFleetTokenForDevProxy,
): void {
  proxy.on('proxyReq', (proxyReq) => {
    const token = readToken();
    if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`);
  });
}
