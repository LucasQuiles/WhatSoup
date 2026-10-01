// runtime.ts re-exports these, so existing importers keep runtime.ts as their entry point.
import type { TurnRecoveryCatchupReconcileOptions } from '../../core/turn-recovery-catchup-config.ts';
import type { fetchAnthropicModelIdsWithStatus } from '../../lib/model-advisor.ts';
import type { AccountIdentityVerifyFn } from './account-identity-verifier.ts';
import type { listModelCatalog } from './providers/binary-preflight.ts';
import type { ServiceRestarter } from './self-restart.ts';

export interface SandboxPolicy {
  allowedPaths: string[];
  allowedTools: string[];
  allowedMcpTools?: string[];
  bash: { enabled: boolean };
  /**
   * Opt-in egress allowlist (#1607 / QR-008). A non-empty list makes
   * `start()` boot a loopback `EgressProxy` bound to this policy and inject
   * its port into the child process env (see `egressProxyPort` on
   * `SessionManager`/`buildBaseChildEnv`). Absent or empty: no proxy, no env
   * injection — unchanged pre-#1607 behavior.
   */
  allowedEgress?: string[];
}

export type SessionScope = 'single' | 'shared' | 'per_chat';

export interface AgentRuntimeOptions {
  shared?: boolean;
  /** Session scope: 'single' (one chat), 'shared' (one session, many chats), 'per_chat' (one session per chat). */
  sessionScope?: SessionScope;
  cwd?: string;
  configSystemPrompt?: string;
  instructionsPath?: string;
  sandbox?: SandboxPolicy;
  /** Claude model identifier to pass via --model flag (e.g. 'claude-opus-4-6[1m]'). */
  model?: string;
  /** When true, each chat gets an isolated workspace directory with its own Claude config. Requires sessionScope 'per_chat'. */
  sandboxPerChat?: boolean;
  /**
   * When true, the per-chat actor socket carries a conversation-bound
   * SessionContext (see per-chat-actor-session.ts and docs/configuration.md).
   * Default false — the #1785 rec-3 behavior (send confinement only) is
   * unchanged. Requires sessionScope 'per_chat'; incompatible with sandboxPerChat.
   */
  perChatConversationBound?: boolean;
  /** Plugin directories to pass via --plugin-dir to the claude subprocess. */
  pluginDirs?: string[];
  /** Per-instance plugin enablement. Written to project settings.json to override global. */
  enabledPlugins?: Record<string, boolean>;
  /** Per-instance opt-in for propagating ALLOW_M365_MUTATIONS when fail-closed mode is enabled. */
  allowM365Mutations?: boolean;
  /** Automatically run a silent /compact after this many input tokens since the last compact. */
  autoCompactInputTokens?: number;
  /** Reply Guarantee timeout override for tests and tightly controlled deployments. */
  replyGuaranteeTimeoutMs?: number;
  /**
   * #3295 S2 (default OFF): defer replay-safe per_chat followers blocked
   * solely by outstanding turn recovery into durable obligations instead of
   * terminally rejecting them. Evaluated PER ADMISSION (kill-switch
   * semantics): flipping `enabled` off stops deferral immediately. Drain is
   * S3; until it lands an obligation only accumulates.
   */
  deferredTurnAdmission?: { enabled: boolean };
  /** Catch-up reconciler gate (default OFF); see turn-recovery-catchup-config.ts. */
  turnRecoveryCatchupReconcile?: TurnRecoveryCatchupReconcileOptions;
  /**
   * Systemd restart capability, injected from the composition root. The runtimes
   * layer cannot import the fleet layer, so main.ts constructs the concrete
   * ServiceManager and passes it here. When absent, the restart_self tool is not
   * registered (the agent cannot restart itself without it).
   */
  serviceRestarter?: ServiceRestarter;
  /**
   * Test-injectable catalogue probes for the `/model N` pin-time verify
   * (Task H — resolveModelCatalogue's own listFn/anthropicFn seam, threaded
   * one level further out so a test constructing the runtime can supply a
   * fake catalogue without spawning a real binary or hitting a real
   * keychain). Undefined in production — resolveModelCatalogue falls back
   * to the real probes.
   */
  modelCatalogueListFn?: typeof listModelCatalog;
  modelCatalogueAnthropicFn?: typeof fetchAnthropicModelIdsWithStatus;
  /**
   * Ratified account-identity digest (`service.expectedAccountDigest`,
   * task-21). When set, the runtime verifies the claude CLI's serving
   * identity against it on startup and on every primary-usability probe and
   * alerts on mismatch; it never writes a credential. null/undefined =
   * verification disabled (one info note at the first probe).
   */
  expectedAccountDigest?: string | null;
  /** Test seam for the identity verification (defaults to the real CLI probe). */
  accountIdentityVerify?: AccountIdentityVerifyFn;
}
