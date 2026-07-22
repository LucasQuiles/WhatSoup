import type { IdentityStore } from '../../src/core/outbound-identity/types.ts';

const WARM_IDENTITY_STORE: IdentityStore = {
  resolveLid: (lidBare) => `${lidBare}@s.whatsapp.net`,
  isWarm: () => true,
  isApprovedGroup: () => true,
};

interface IdentityStoreConfigurable {
  setIdentityStore(store: IdentityStore, mode: 'enforce'): void;
}

export function withWarmIdentity<T extends IdentityStoreConfigurable>(connection: T): T {
  connection.setIdentityStore(WARM_IDENTITY_STORE, 'enforce');
  return connection;
}
