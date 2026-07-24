import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const hookPath = path.join(repoRoot, ".husky/check-commit-identity.sh");

function checkIdentity(name: string, email: string) {
  return spawnSync("/bin/bash", [hookPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    },
  });
}

describe("commit identity allowlist", () => {
  it.each([
    ["SoupBot QPI 1", "308864230+qpi-lab@users.noreply.github.com"],
    ["SoupBot QPI 2", "308865677+qpi-lab2@users.noreply.github.com"],
    ["SoupBot", "soupbot@users.noreply.github.com"],
  ])("accepts the approved identity %s", (name, email) => {
    const result = checkIdentity(name, email);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a mismatched machine name and address", () => {
    const result = checkIdentity(
      "SoupBot QPI 1",
      "308865677+qpi-lab2@users.noreply.github.com",
    );

    expect(result.status).not.toBe(0);
  });

  it("rejects an unapproved personal identity", () => {
    const result = checkIdentity("Example Person", "person@example.test");

    expect(result.status).not.toBe(0);
  });
});
