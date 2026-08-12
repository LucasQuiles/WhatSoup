# BOT ERRORS deployment log — append-only, not normative

Current close-out baseline: the 2026-06-13 C2/C3/C4 fleet pass streamed the
manifest-tracked bot-errors runtime payload from an isolated operator staging directory,
built from `289c5f7b77c86e64d2ee5ef820aabd7e21492a78`. At deploy time,
`origin/main=2197bfdc`; the intervening diff did not touch bot-errors runtime,
hook, profile, or manifest inputs.

Known residuals after the close-out pass:

- One Git-backed macOS host has current runtime files and manifests, but hook activation
  is blocked by root-owned `.git/config` and `.git/hooks/pre-commit`.
- Non-Git mini runtime trees are not hook-capable; they can still run the copied runtime
  payload and host-local manifest.
- Stream-sync proves runtime payload currency. It does not imply that every dirty host
  checkout was advanced to the latest `origin/main`.
