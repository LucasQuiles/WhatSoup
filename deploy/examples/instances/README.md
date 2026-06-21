# Example instance configs

Canonical, valid `config.json` files for each instance type. They double as the
default fixtures for the instance-config integrity guard:

```bash
npm run guard:instance-config            # validates these examples
npm run guard:instance-config -- --root ~/.config/whatsoup/instances   # a live host, offline
```

The guard (`scripts/check-instance-config.ts`) enforces two failure classes the
permissive runtime schema otherwise lets through silently:

- **Class A — memory-config integrity.** An `agent`/`chat` instance with a
  `memory` block must carry a well-shaped `memory.pinecone.expectedHostSuffix`
  (`-<slug>.svc.<env>.pinecone.io`). If `memory.pinecone.projectId` is set, it
  must be the short host slug, not a UUID. An empty `memory: {}` on a
  memory-consuming bot leaves the runtime project guard firing
  `project_mismatch` with no error — the memory layer is silently dead. A
  `projectId` UUID trips the `host.includes("-<projectId>.")` check against the
  standard slug-based host shape and fails closed the same way.

- **Class B — health-port map.** Across one host, every effective health port
  must be unique, every explicit `healthPort` must fall inside the agreed band
  (`INSTANCE_HEALTH_PORT_MIN`–`INSTANCE_HEALTH_PORT_MAX` in
  `src/fleet/constants.ts`), and must never equal the fleet/console port
  (`DEFAULT_FLEET_PORT`, 9099) — a bot on the console port makes fleet tooling
  hit the bot instead of the console. An instance that omits `healthPort`
  resolves to the runtime default (`DEFAULT_INSTANCE_HEALTH_PORT`, 9090); the
  guard counts that default toward collision detection, so two no-port
  instances (or a no-port instance plus an explicit 9090) are flagged rather
  than silently binding the same port at startup.

Schema completeness (name/type/accessMode/adminPhones/port range, transport
coherence) is delegated to the shared validator in
`src/core/agent-config-validator.ts`, so the guard stays in lockstep with the
runtime loader.
