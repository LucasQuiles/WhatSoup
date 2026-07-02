# Phonectl Asset Inventory

`phonectl.asset_inventory` is the durable local SSOT for physical Android phones,
SIM/eSIM profiles, bot assignments, admins, and ADB/network topology used by the
WhatSoup phone fleet.

Default state:

```text
~/.phonectl/state/assets.sqlite3
~/.phonectl/state/assets.hmac.key
```

The state directory is owner-only (`0700`), the SQLite database and local HMAC key
are owner-only (`0600`), and the database runs in WAL mode. Tests inject temp DBs
with `--db` or `AssetInventory(path, hmac_key=...)`.

## Schema

The first migration creates:

- `physical_device`: asset/device identity, Android/build facts, ADB serial,
  lifecycle status, source, confidence, first/last seen.
- `device_usb_serial`: historical observed USB serials.
- `device_identifiers`: raw IMEI/EID/MEID/serial values in DB only, plus
  deterministic HMAC hashes and redacted display values.
- `sim_profile`: raw ICCID/MSISDN/subscription values in DB only, plus HMAC
  hashes, redacted display values, carrier, slot, activation, assigned device.
- `bot_assignment`: active and historical bot-to-line/device/service mappings;
  moves close the old row and create a new row.
- `admin_assignment`: principal/admin mapping with unknown/unassigned allowed.
- `network_topology`: historical USB/Wi-Fi ADB endpoints and proof status.
- `inventory_event`: create/update/reassignment/discovery audit events with
  safe before/after JSON and redaction scan status.
- `schema_migrations`: explicit schema version tracking.

## Redaction Model

Raw phone numbers, ICCIDs, IMEIs, eSIM IMEIs, EIDs, MEIDs, SIM subscription IDs,
admin phone numbers, WhatsApp IDs, and auth-directory paths are database-only.
Normal CLI JSON, artifact packs, proof-gate output, and event diffs expose only:

- redacted display values such as `ending 0555`;
- deterministic `hmac_sha256:<digest>` matching hashes;
- non-sensitive operational fields.

The HMAC key is local to the operator host. Set `PHONECTL_ASSET_HMAC_KEY` for
test/reproducible environments; otherwise the tool creates
`~/.phonectl/state/assets.hmac.key`.

Encryption-at-rest for the SQLite DB and raw secure exports is not implemented in
this first slice. The immediate control is owner-only filesystem permissions plus
safe JSON/export paths. `secure-export --encrypted <path>` fails closed until a
real encrypted-export backend is added.

## Commands

```bash
python -m phonectl.asset_inventory init
python -m phonectl.asset_inventory discover --adb-target SERIAL --host operator-host --json
python -m phonectl.asset_inventory upsert-device --adb-serial SERIAL --lifecycle-status staging --json
python -m phonectl.asset_inventory assign-bot --bot ad-bot --device ASSET_OR_SERIAL --phone '+1555...' --trust-note /path/to/trust-note.md --json
python -m phonectl.asset_inventory topology --json
python -m phonectl.asset_inventory verify --bot ad-bot --json
python -m phonectl.asset_inventory proof-gate --bot ad-bot --json
python -m phonectl.asset_inventory wifi-adb-proof --bot ad-bot --json
python -m phonectl.asset_inventory config-lint --bot ad-bot --json
python -m phonectl.asset_inventory artifact-pack --bot ad-bot --output /private/path --json
python -m phonectl.asset_inventory export --safe-json
python -m phonectl.asset_inventory secure-export --encrypted /private/path
```

Use `--db /tmp/assets.sqlite3` for tests and dry runs.

## Identity Rules

- IP address is transport, never identity.
- ADB endpoint is transport, never identity.
- Phone number is line identity, not physical-device identity.
- Bot slug is assignment identity, not physical-device identity.
- `assign-bot --device` resolves a canonical device UUID, asset tag, current ADB
  serial, historical USB serial, or `ro.serialno`; ambiguous or unknown references
  fail closed.
- Serial/IMEI/ICCID/EID collisions fail closed.
- Bot moves preserve history by closing the previous active assignment.
- Banned, degraded, and retired devices remain queryable.
- Wi-Fi-mandatory proof is satisfied only by a recorded Wi-Fi ADB endpoint, not
  by USB presence alone.

## Mutation Boundary

`discover` only runs read-only `adb shell getprop` probes and writes the asset DB.
It does not relink WhatsApp, mutate auth directories, send messages, clear auth,
restart services, or pair devices.

Any `assign-bot` change requires a non-empty owner-approved trust note path.
Without that path the command fails closed.

## Current Seed Boundary

The first production seed may record read-only ADB observations into the default DB:

- physical devices seen through USB or Wi-Fi ADB;
- Android/build facts available through `getprop`;
- historical Wi-Fi ADB endpoints as topology, not identity.

Do not write `ad-bot`, `ml-bot`, SIM/eSIM, phone-number, or admin assignments from
memory. Those rows require either direct owner-attested evidence or a trust note.
Unknown with a reason is preferred over a guessed line/device mapping.
