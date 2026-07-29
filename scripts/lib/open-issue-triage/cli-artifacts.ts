import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  acquireProcessLock,
  isProcessLockError,
  readProcessLockPayload,
  releaseProcessLock,
  type ProcessLockHandle,
} from "../../../src/lib/process-lock.ts";
import {
  parseRegistry,
  registrySha256,
  validateRegistry,
  type OpenIssueRegistry,
} from "./model.ts";
import { CliFailure, GENERATED_VIEW, type CliRuntime } from "./cli-command.ts";

function markdownList(values: readonly string[]): string {
  return values.length === 0
    ? "None"
    : values.map((value) => `\`${value}\``).join(", ");
}

export function renderRegistryMarkdown(input: OpenIssueRegistry): string {
  const lines = [
    "# Open issue review registry",
    "",
    "> Generated from `docs/triage/open-issue-registry.json`. Do not edit this view by hand.",
    "",
    `- Pinned main revision: \`${input.pinned_main_revision}\``,
    `- Captured at: ${input.inventory.captured_at}`,
    `- Open issues: ${input.inventory.open_issue_count}`,
    `- Registry SHA-256: \`${registrySha256(input)}\``,
    "",
  ];
  for (const issue of [...input.issues].sort(
    (left, right) => left.issue_number - right.issue_number,
  )) {
    lines.push(
      `## #${issue.issue_number}: ${issue.recommended_title ?? issue.title}`,
      "",
      `- Classification: \`${issue.classification}\``,
      `- Evidence state: \`${issue.evidence_state}\``,
      `- Confidence: \`${issue.review_confidence}\``,
      `- Current labels: ${markdownList(issue.current_labels)}`,
      `- Recommended labels: ${markdownList(issue.recommended_labels)}`,
      `- Dependencies: ${issue.dependency_issue_numbers.length === 0 ? "None" : issue.dependency_issue_numbers.map((number) => `#${number}`).join(", ")}`,
      "",
      "### Evidence",
      "",
      issue.evidence_summary,
      "",
      "### Suggested remediation",
      "",
      issue.suggested_remediation,
      "",
      "### Impact and blast radius",
      "",
      `${issue.impact} ${issue.blast_radius}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export function safeRelativePath(value: string, label: string): string[] {
  if (
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CliFailure(
      4,
      "unsafe-path",
      `${label} is not a safe repository-relative path`,
      "Use a documented repository-relative path.",
    );
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new CliFailure(
      4,
      "unsafe-path",
      `${label} contains an unsafe path segment`,
      "Use a documented repository-relative path.",
    );
  }
  return parts;
}

export function identity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

interface AncestorIdentity {
  path: string;
  devIno: string;
  realpath: string;
}

interface ArtifactPath {
  absolute: string;
  parent: string;
  ancestors: AncestorIdentity[];
}

interface ArtifactLock {
  path: string;
  devIno: string;
  realpath: string;
  handle: ProcessLockHandle;
}

function artifactIdentityChanged(message: string): CliFailure {
  return new CliFailure(
    4,
    "artifact-identity-changed",
    message,
    "Inspect concurrent repository activity and retry only after the canonical path is restored.",
  );
}

function captureAncestorIdentities(
  root: string,
  parts: readonly string[],
  createLeaf = false,
): {
  parent: string;
  ancestors: AncestorIdentity[];
} {
  const ancestors: AncestorIdentity[] = [];
  let cursor = root;
  const captureDirectory = (path: string): void => {
    let stat: Stats;
    let resolved: string;
    try {
      stat = lstatSync(path);
      resolved = realpathSync(path);
    } catch {
      throw new CliFailure(
        4,
        "unsafe-path",
        "A required artifact ancestor is missing",
        "Create only the documented docs/triage artifact directory.",
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CliFailure(
        4,
        "unsafe-path",
        "An artifact ancestor is not a real directory",
        "Replace symlinked or non-directory ancestors before retrying.",
      );
    }
    if (!isInside(root, resolved)) {
      throw new CliFailure(
        4,
        "unsafe-path",
        "An artifact ancestor escapes the repository",
        "Use the documented docs/triage subtree.",
      );
    }
    ancestors.push({ path, devIno: identity(stat), realpath: resolved });
  };

  captureDirectory(root);
  for (const [index, part] of parts.entries()) {
    const next = join(cursor, part);
    let missing = false;
    try {
      lstatSync(next);
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) {
        throw error;
      }
    }
    if (missing) {
      if (!createLeaf || index !== parts.length - 1) {
        throw new CliFailure(
          4,
          "unsafe-path",
          "A required artifact ancestor is missing",
          "Create only the documented docs/triage artifact directory.",
        );
      }
      revalidateAncestorIdentities(root, ancestors);
      mkdirSync(next, { mode: 0o755 });
    }
    captureDirectory(next);
    cursor = next;
  }
  return { parent: cursor, ancestors };
}

function revalidateAncestorIdentities(
  root: string,
  ancestors: readonly AncestorIdentity[],
): void {
  for (const expected of ancestors) {
    let stat: Stats;
    let resolved: string;
    try {
      stat = lstatSync(expected.path);
      resolved = realpathSync(expected.path);
    } catch {
      throw artifactIdentityChanged(
        "An artifact ancestor disappeared during creation",
      );
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      identity(stat) !== expected.devIno ||
      resolved !== expected.realpath ||
      !isInside(root, resolved)
    ) {
      throw artifactIdentityChanged(
        "An artifact ancestor changed during creation",
      );
    }
  }
}

export function assertRealAncestors(
  root: string,
  parts: readonly string[],
  createLeaf = false,
): string {
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    if (!existsSync(cursor) && createLeaf && index === parts.length - 1) {
      mkdirSync(cursor, { mode: 0o755 });
    }
    let stat: Stats;
    try {
      stat = lstatSync(cursor);
    } catch {
      throw new CliFailure(
        4,
        "unsafe-path",
        "A required artifact ancestor is missing",
        "Create only the documented docs/triage artifact directory.",
      );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CliFailure(
        4,
        "unsafe-path",
        "An artifact ancestor is not a real directory",
        "Replace symlinked or non-directory ancestors before retrying.",
      );
    }
    if (!isInside(root, realpathSync(cursor))) {
      throw new CliFailure(
        4,
        "unsafe-path",
        "An artifact ancestor escapes the repository",
        "Use the documented docs/triage subtree.",
      );
    }
  }
  return cursor;
}

export function resolveExistingFile(
  rootInput: string,
  relativePath: string,
  label: string,
): string {
  const root = realpathSync(rootInput);
  const parts = safeRelativePath(relativePath, label);
  const parent = assertRealAncestors(root, parts.slice(0, -1));
  const absolute = join(parent, parts.at(-1)!);
  let stat: Stats;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new CliFailure(
      2,
      "file-not-found",
      `${label} does not exist`,
      "Pass an existing repository-confined file.",
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new CliFailure(
      4,
      "unsafe-path",
      `${label} is not a real single-link regular file`,
      "Use a regular tracked file with no aliases.",
    );
  }
  if (!isInside(root, realpathSync(absolute))) {
    throw new CliFailure(
      4,
      "unsafe-path",
      `${label} escapes the repository`,
      "Use a repository-confined file.",
    );
  }
  return absolute;
}

function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("short artifact write");
    offset += written;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function acquireArtifactLock(root: string): ArtifactLock {
  const path = join(root, ".open-issue-triage-artifact-write.lock");
  let previousIdentity: string | null = null;
  try {
    const previous = lstatSync(path);
    const previousRealpath = realpathSync(path);
    if (
      !previous.isFile() ||
      previous.isSymbolicLink() ||
      previous.nlink !== 1 ||
      !isInside(root, previousRealpath)
    ) {
      throw artifactIdentityChanged(
        "The existing artifact lock is not a repository-confined single-link file",
      );
    }
    previousIdentity = identity(previous);
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let handle: ProcessLockHandle;
  try {
    handle = acquireProcessLock(path, {
      reclaimDeadSameBoot: true,
      beforeReclaimUnlink:
        previousIdentity === null
          ? undefined
          : () => {
              const current = lstatSync(path);
              if (
                !current.isFile() ||
                current.isSymbolicLink() ||
                current.nlink !== 1 ||
                identity(current) !== previousIdentity
              ) {
                throw artifactIdentityChanged(
                  "The stale artifact lock changed during recovery",
                );
              }
            },
    });
  } catch (error) {
    if (isProcessLockError(error)) {
      const recoveryRequired = error.reason !== "active";
      throw new CliFailure(
        4,
        recoveryRequired
          ? "artifact-lock-recovery-required"
          : "artifact-write-locked",
        recoveryRequired
          ? "The artifact writer lock cannot be recovered automatically"
          : "Another cooperating artifact writer owns the repository lock",
        recoveryRequired
          ? "Inspect the owner payload and recover the corrupt, unknown-boot, or concurrently changed lock."
          : "Wait for the active writer to finish before retrying.",
        !recoveryRequired,
      );
    }
    throw error;
  }

  try {
    const opened = lstatSync(path);
    const resolved = realpathSync(path);
    const payload = readProcessLockPayload(path);
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      !isInside(root, resolved) ||
      payload?.pid !== handle.pid ||
      payload.token !== handle.token
    ) {
      throw artifactIdentityChanged(
        "The artifact lock is not a real single-link file",
      );
    }
    return { path, devIno: identity(opened), realpath: resolved, handle };
  } catch (error) {
    releaseProcessLock(handle);
    throw error;
  }
}

function revalidateArtifactLock(root: string, lock: ArtifactLock): void {
  let stat: Stats;
  let resolved: string;
  try {
    stat = lstatSync(lock.path);
    resolved = realpathSync(lock.path);
  } catch {
    throw artifactIdentityChanged(
      "The artifact lock disappeared before release",
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    identity(stat) !== lock.devIno ||
    resolved !== lock.realpath ||
    !isInside(root, resolved)
  ) {
    throw artifactIdentityChanged(
      "The artifact lock identity changed while held",
    );
  }
  const payload = readProcessLockPayload(lock.path);
  if (payload?.pid !== lock.handle.pid || payload.token !== lock.handle.token) {
    throw artifactIdentityChanged(
      "The artifact lock ownership changed while held",
    );
  }
}

function releaseArtifactLock(root: string, lock: ArtifactLock): void {
  revalidateArtifactLock(root, lock);
  if (
    !releaseProcessLock(lock.handle, {
      beforeReleaseUnlink: () => revalidateArtifactLock(root, lock),
    })
  ) {
    throw artifactIdentityChanged(
      "The artifact lock ownership changed before release",
    );
  }
  fsyncDirectory(root);
}

function withArtifactLock<T>(
  root: string,
  operation: (assertLock: () => void) => T,
): T {
  const lock = acquireArtifactLock(root);
  const assertLock = (): void => revalidateArtifactLock(root, lock);
  try {
    assertLock();
    const result = operation(assertLock);
    assertLock();
    releaseArtifactLock(root, lock);
    return result;
  } catch (error) {
    try {
      releaseArtifactLock(root, lock);
    } catch {
      // Preserve the decisive operation failure and leave an unverifiable lock untouched.
    }
    throw error;
  }
}

function artifactParent(
  root: string,
  output: string,
  pattern: RegExp,
): ArtifactPath {
  if (!pattern.test(output)) {
    throw new CliFailure(
      4,
      "unsafe-output-path",
      "Output is outside the fixed artifact subtree",
      "Use the exact docs/triage/plans or docs/triage/snapshots path.",
    );
  }
  const parts = safeRelativePath(output, "output");
  const { parent, ancestors } = captureAncestorIdentities(
    root,
    parts.slice(0, -1),
    true,
  );
  return { absolute: join(parent, parts.at(-1)!), parent, ancestors };
}

function verifyOpenedArtifact(
  root: string,
  path: ArtifactPath,
  descriptor: number,
  expectedDescriptorIdentity?: string,
): string {
  revalidateAncestorIdentities(root, path.ancestors);
  let opened: Stats;
  let final: Stats;
  let resolved: string;
  try {
    opened = fstatSync(descriptor);
    final = lstatSync(path.absolute);
    resolved = realpathSync(path.absolute);
  } catch {
    throw artifactIdentityChanged(
      "The artifact path disappeared while its descriptor was open",
    );
  }
  const openedIdentity = identity(opened);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    !final.isFile() ||
    final.isSymbolicLink() ||
    final.nlink !== 1 ||
    identity(final) !== openedIdentity ||
    (expectedDescriptorIdentity !== undefined &&
      openedIdentity !== expectedDescriptorIdentity) ||
    !isInside(root, resolved)
  ) {
    throw artifactIdentityChanged(
      "The artifact path no longer matches its open descriptor",
    );
  }
  return openedIdentity;
}

function verifyFinalArtifact(
  root: string,
  path: ArtifactPath,
  descriptorIdentity: string,
): void {
  revalidateAncestorIdentities(root, path.ancestors);
  let final: Stats;
  let resolved: string;
  try {
    final = lstatSync(path.absolute);
    resolved = realpathSync(path.absolute);
  } catch {
    throw artifactIdentityChanged(
      "The final artifact path disappeared after synchronization",
    );
  }
  if (
    !final.isFile() ||
    final.isSymbolicLink() ||
    final.nlink !== 1 ||
    identity(final) !== descriptorIdentity ||
    !isInside(root, resolved)
  ) {
    throw artifactIdentityChanged(
      "The final artifact path no longer matches the synchronized descriptor",
    );
  }
}

export function writeExclusive(
  rootInput: string,
  output: string,
  pattern: RegExp,
  text: string,
  runtime: CliRuntime,
): void {
  const root = realpathSync(rootInput);
  withArtifactLock(root, (assertLock) => {
    const path = artifactParent(root, output, pattern);
    try {
      lstatSync(path.absolute);
      throw new CliFailure(
        4,
        "artifact-exists",
        "The output artifact already exists",
        "Choose a new stable artifact identifier; never overwrite reviewed evidence.",
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const hookContext = { root, output, absolute: path.absolute };
    runtime.artifactHooks?.beforeOpen?.(hookContext);
    assertLock();
    revalidateAncestorIdentities(root, path.ancestors);
    let descriptor: number;
    try {
      descriptor = openSync(
        path.absolute,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o644,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ELOOP") {
        throw new CliFailure(
          4,
          "artifact-exists",
          "The output artifact already exists",
          "Choose a new stable artifact identifier; never overwrite reviewed evidence.",
        );
      }
      throw error;
    }
    let descriptorIdentity: string;
    try {
      runtime.artifactHooks?.afterOpenBeforeMutation?.(hookContext);
      assertLock();
      descriptorIdentity = verifyOpenedArtifact(root, path, descriptor);
      writeAll(descriptor, text);
      fsyncSync(descriptor);
      assertLock();
      verifyOpenedArtifact(root, path, descriptor, descriptorIdentity);
    } finally {
      closeSync(descriptor);
    }
    revalidateAncestorIdentities(root, path.ancestors);
    fsyncDirectory(path.parent);
    verifyFinalArtifact(root, path, descriptorIdentity!);
  });
}

export function writeConfinedGeneratedFile(
  rootInput: string,
  relativePath: string,
  text: string,
  runtime: CliRuntime,
): void {
  const root = realpathSync(rootInput);
  withArtifactLock(root, (assertLock) => {
    const parts = safeRelativePath(relativePath, "generated file");
    const { parent, ancestors } = captureAncestorIdentities(
      root,
      parts.slice(0, -1),
    );
    const path = { absolute: join(parent, parts.at(-1)!), parent, ancestors };
    const hookContext = {
      root,
      output: relativePath,
      absolute: path.absolute,
    };
    let exists = false;
    try {
      const before = lstatSync(path.absolute);
      exists = true;
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new CliFailure(
          4,
          "unsafe-generated-view",
          "Generated view is not a real single-link file",
          "Repair the generated view path before writing.",
        );
      }
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    runtime.artifactHooks?.beforeOpen?.(hookContext);
    assertLock();
    revalidateAncestorIdentities(root, ancestors);
    let descriptor: number;
    try {
      descriptor = openSync(
        path.absolute,
        exists
          ? constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
          : constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              (constants.O_NOFOLLOW ?? 0),
        0o644,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ELOOP") {
        throw new CliFailure(
          4,
          "unsafe-generated-view",
          "Generated view identity changed before open",
          "Inspect concurrent repository activity and repair the generated view path.",
        );
      }
      throw error;
    }
    let descriptorIdentity: string;
    try {
      runtime.artifactHooks?.afterOpenBeforeMutation?.(hookContext);
      assertLock();
      descriptorIdentity = verifyOpenedArtifact(root, path, descriptor);
      if (exists) ftruncateSync(descriptor, 0);
      writeAll(descriptor, text);
      fsyncSync(descriptor);
      assertLock();
      verifyOpenedArtifact(root, path, descriptor, descriptorIdentity);
    } finally {
      closeSync(descriptor);
    }
    revalidateAncestorIdentities(root, ancestors);
    fsyncDirectory(parent);
    verifyFinalArtifact(root, path, descriptorIdentity!);
  });
}

export function writeGeneratedView(
  rootInput: string,
  text: string,
  runtime: CliRuntime,
): void {
  writeConfinedGeneratedFile(rootInput, GENERATED_VIEW, text, runtime);
}

export function readUnknownJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CliFailure(
      2,
      "file-read-failed",
      `${label} could not be read`,
      "Check the repository file permissions.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliFailure(
      2,
      "invalid-json",
      `${label} is not valid JSON`,
      "Regenerate or repair the artifact before retrying.",
    );
  }
}

export function loadRegistry(
  root: string,
  relativePath: string,
): {
  registry: OpenIssueRegistry;
  value: unknown;
} {
  const path = resolveExistingFile(root, relativePath, "registry");
  const value = readUnknownJson(path, "registry");
  let registry: OpenIssueRegistry;
  try {
    registry = parseRegistry(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.startsWith("PUBLIC registry rejected:") ||
      message.startsWith("redaction_violation:")
    ) {
      throw new CliFailure(
        4,
        "public-safety-rejection",
        "Registry content violates the PUBLIC artifact policy",
        "Remove private runtime identifiers and complete issue bodies before retrying.",
      );
    }
    throw new CliFailure(
      2,
      "registry-schema-invalid",
      "Registry JSON violates the PUBLIC schema",
      "Regenerate a complete registry using the reviewed population workflow.",
    );
  }
  const findings = validateRegistry(registry);
  if (findings.length > 0) {
    throw new CliFailure(
      2,
      "registry-invalid",
      "Registry semantic validation failed",
      "Resolve every deterministic registry finding before retrying.",
      false,
      {
        finding_codes: findings.slice(0, 20).map((finding) => finding.code),
        truncated: findings.length > 20,
      },
    );
  }
  return { registry, value };
}
