type TestResource = {
  socketPath: string;
  server: { stop(): void };
  ready: Promise<void>;
  identity: { value: string };
};

export class FakePerChatMcpSocketManager {
  readonly resources = new Map<string, TestResource>();
  private readonly barriers = new Map<string, Promise<void>>();
  private nextSocketId = 0;

  acquire(identity: string): { socketPath: string; ready: Promise<void> } {
    const barrier = this.barriers.get(identity);
    if (barrier) {
      const socketPath = this.resources.get(identity)?.socketPath
        ?? `/tmp/whatsoup-runtime-test-${this.nextSocketId}.sock`;
      return { socketPath, ready: barrier.then(() => this.acquire(identity).ready) };
    }
    const existing = this.resources.get(identity);
    if (existing) return { socketPath: existing.socketPath, ready: existing.ready };
    const resource: TestResource = {
      socketPath: `/tmp/whatsoup-runtime-test-${this.nextSocketId++}.sock`,
      server: { stop() {} },
      ready: Promise.resolve(),
      identity: { value: identity },
    };
    this.resources.set(identity, resource);
    return { socketPath: resource.socketPath, ready: resource.ready };
  }

  release(identity: string): void {
    if (this.barriers.has(identity)) {
      throw new Error('actor MCP socket release requires terminal child proof');
    }
    const resource = this.resources.get(identity);
    if (!resource) return;
    resource.server.stop();
    this.resources.delete(identity);
  }

  providerTransitionReady(identity: string): Promise<void> {
    return this.barriers.get(identity) ?? Promise.resolve().then(() => this.release(identity));
  }

  releaseAfter(identity: string, childStopped: Promise<void>): void {
    if (this.barriers.has(identity)) return;
    const barrier = childStopped.then(() => {
      this.barriers.delete(identity);
      this.release(identity);
    });
    this.barriers.set(identity, barrier);
    void barrier.catch(() => {});
  }

  rekey(oldIdentity: string, newIdentity: string): void {
    if (oldIdentity === newIdentity) return;
    const resource = this.resources.get(oldIdentity);
    if (resource) {
      if (this.resources.has(newIdentity)) throw new Error('actor MCP socket rekey collision');
      this.resources.delete(oldIdentity);
      resource.identity.value = newIdentity;
      this.resources.set(newIdentity, resource);
    }
    const barrier = this.barriers.get(oldIdentity);
    if (barrier) {
      if (this.barriers.has(newIdentity)) throw new Error('actor MCP socket rekey collision');
      this.barriers.delete(oldIdentity);
      this.barriers.set(newIdentity, barrier);
    }
  }
}
