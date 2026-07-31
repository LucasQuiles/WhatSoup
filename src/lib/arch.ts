// src/lib/arch.ts
// Architecture-aware binary-resolution utilities for cross-platform portability.
//
// Pre-built or self-hosted binaries often append an architecture suffix to the
// binary name (e.g. `ffmpeg-arm64`, `node_exporter-arm64`). These helpers
// provide a consistent mapping from the running Node.js process.arch to the
// platforms conventional suffix so that binary-resolution callers resolve the
// correct binary for the host architecture.

import { arch } from "node:process";

export type KnownArch = "arm64" | "aarch64" | "x64" | "x86_64" | "ia32" | "loong64" | "riscv64" | "ppc64" | "s390x";

/**
 * Map `process.arch` to the conventional binary-name suffix for this host.
 *
 * Returns a dash-prefixed string (e.g. `"-arm64"`, `"-x64"`) that can be
 * spliced between a base binary name and its file extension, or as a suffix
 * on a bare name. Returns `""` for unknown/unrecognised architectures so
 * that callers degrade gracefully (defaulting to an unadorned name) rather
 * than failing with an unknown suffix.
 *
 * Canonical mapping (matching Debian multiarch conventions where applicable):
 *   arm64  → "-arm64"
 *   aarch64 → "-arm64"     (aliased — Node normalises to "arm64")
 *   x64    → "-x64"
 *   x86_64 → "-x64"       (aliased — Node normalises to "x64")
 *   ia32   → "-ia32"
 *   loong64 → "-loong64"
 *   riscv64 → "-riscv64"
 *   ppc64  → "-ppc64"
 *   s390x  → "-s390x"
 *   *      → ""
 */
export function getArchBinSuffix(): string {
  const archStr: string = arch;
  switch (archStr) {
    case "arm64":
    case "aarch64":
      return "-arm64";
    case "x64":
    case "x86_64":
      return "-x64";
    case "ia32":
      return "-ia32";
    case "loong64":
      return "-loong64";
    case "riscv64":
      return "-riscv64";
    case "ppc64":
      return "-ppc64";
    case "s390x":
      return "-s390x";
    default:
      return "";
  }
}

/**
 * Return a human-readable architecture label for diagnostics and health
 * reporting (e.g. `"arm64"`, `"x86_64"`). Unlike `getArchBinSuffix()`, this
 * returns the arch name without a leading dash, and normalises to a stable
 * label even for aliased values.
 *
 *   arm64/aarch64 → "arm64"
 *   x64/x86_64    → "x86_64"
 *   ia32          → "ia32"
 *   *             → arch as-is
 */
export function getArchLabel(): string {
  const archStr: string = arch;
  switch (archStr) {
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x64":
    case "x86_64":
      return "x86_64";
    case "ia32":
      return "ia32";
    case "loong64":
      return "loong64";
    case "riscv64":
      return "riscv64";
    case "ppc64":
      return "ppc64";
    case "s390x":
      return "s390x";
    default:
      return arch;
  }
}

/**
 * Return the architecture suffix used by the system package manager for
 * platform-specific binary paths (e.g. `"aarch64"` for Homebrew on Apple
 * Silicon, `"x86_64"` for Intel). Useful when constructing paths that
 * mirror upstream convention rather than Node.js convention.
 *
 * The mapping differs from `getArchBinSuffix()` in that:
 *   - Returns bare arch strings (no leading dash).
 *   - arm64 → "aarch64" (Linux/Homebrew convention, not Node convention).
 *   - x64   → "x86_64" (POSIX convention).
 */
export function getPlatformArch(): string {
  const archStr: string = arch;
  switch (archStr) {
    case "arm64":
    case "aarch64":
      return "aarch64";
    case "x64":
    case "x86_64":
      return "x86_64";
    default:
      return arch;
  }
}