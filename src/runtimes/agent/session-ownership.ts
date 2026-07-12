export type OwnedGenerationState =
  | 'starting'
  | 'active'
  | 'resetting'
  | 'recoverable_dead'
  | 'respawning'
  | 'exhausted'
  | 'closing';

export interface OwnedSessionGeneration {
  readonly mapKey: string;
  /** Non-empty, process-unique identity assigned at construction and never reused across ownership epochs. */
  readonly managerId: string;
  generation: number;
  state: OwnedGenerationState;
  respawnTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionOwnershipRegistry {
  private readonly records = new Map<string, OwnedSessionGeneration>();

  get(mapKey: string): OwnedSessionGeneration | undefined {
    const owned = this.records.get(mapKey);
    return owned ? this.snapshot(owned) : undefined;
  }

  claim(mapKey: string, managerId: string): OwnedSessionGeneration {
    this.requireManagerId(managerId);
    if (this.records.has(mapKey)) {
      throw new Error(`Session "${mapKey}" already has an owner`);
    }

    const owned: OwnedSessionGeneration = {
      mapKey,
      managerId,
      generation: 1,
      state: 'starting',
      respawnTimer: null,
    };
    this.records.set(mapKey, owned);
    return this.snapshot(owned);
  }

  advanceGeneration(mapKey: string, managerId: string): number {
    const owned = this.requireOwner(mapKey, managerId);
    owned.generation += 1;
    return owned.generation;
  }

  rekey(fromMapKey: string, toMapKey: string, managerId: string): void {
    const owned = this.requireOwner(fromMapKey, managerId);
    if (fromMapKey === toMapKey) return;
    if (this.records.has(toMapKey)) {
      throw new Error(`Session "${toMapKey}" already has an owner`);
    }
    this.records.delete(fromMapKey);
    this.records.set(toMapKey, { ...owned, mapKey: toMapKey });
  }

  transition(mapKey: string, managerId: string, to: OwnedGenerationState): void {
    this.requireOwner(mapKey, managerId).state = to;
  }

  setRespawnTimer(
    mapKey: string,
    managerId: string,
    generation: number,
    timer: ReturnType<typeof setTimeout>,
  ): boolean {
    const owned = this.records.get(mapKey);
    if (
      owned?.managerId !== managerId ||
      owned.generation !== generation ||
      owned.respawnTimer !== null
    ) {
      return false;
    }
    owned.respawnTimer = timer;
    return true;
  }

  clearRespawnTimer(
    mapKey: string,
    managerId: string,
    generation: number,
    expectedTimer: ReturnType<typeof setTimeout>,
  ): boolean {
    const owned = this.records.get(mapKey);
    if (
      owned?.managerId !== managerId ||
      owned.generation !== generation ||
      owned.respawnTimer !== expectedTimer
    ) {
      return false;
    }
    owned.respawnTimer = null;
    return true;
  }

  release(mapKey: string, managerId: string): void {
    const owned = this.requireOwner(mapKey, managerId);
    if (owned.state !== 'exhausted' && owned.state !== 'closing') {
      throw new Error(`Cannot release session "${mapKey}" from state "${owned.state}"`);
    }
    this.records.delete(mapKey);
  }

  isCurrent(mapKey: string, managerId: string, generation: number): boolean {
    const owned = this.records.get(mapKey);
    return owned?.managerId === managerId && owned.generation === generation;
  }

  private requireOwner(mapKey: string, managerId: string): OwnedSessionGeneration {
    this.requireManagerId(managerId);
    const owned = this.records.get(mapKey);
    if (!owned) {
      throw new Error(`Session "${mapKey}" has no owner`);
    }
    if (owned.managerId !== managerId) {
      throw new Error(`Session "${mapKey}" is not owned by manager "${managerId}"`);
    }
    return owned;
  }

  private requireManagerId(managerId: string): void {
    if (typeof managerId !== 'string' || managerId.length === 0) {
      throw new Error('managerId must be a non-empty string');
    }
  }

  private snapshot(owned: OwnedSessionGeneration): OwnedSessionGeneration {
    return { ...owned };
  }
}
