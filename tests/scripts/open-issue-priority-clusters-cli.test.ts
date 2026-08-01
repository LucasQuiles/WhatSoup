import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runPriorityClusterCli } from "../../scripts/open-issue-priority-clusters.ts";
import { trackTmpDirs } from "../helpers/tmp-dir.ts";

const REGISTRY_TEXT = readFileSync(
  "docs/triage/open-issue-registry.json",
  "utf8",
);
const tmp = trackTmpDirs("");

function fixtureRoot(): string {
  const root = tmp.make("priority-clusters");
  mkdirSync(join(root, "docs/triage"), { recursive: true });
  writeFileSync(
    join(root, "docs/triage/open-issue-registry.json"),
    REGISTRY_TEXT,
  );
  return root;
}

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

describe("priority cluster CLI", () => {
  it("generates both artifacts and reaches deterministic check fixed points", () => {
    const root = fixtureRoot();
    const generated = output();

    expect(runPriorityClusterCli(["generate", "--write"], root, generated.io)).toBe(
      0,
    );
    expect(generated.stderr).toEqual([]);
    const json = readFileSync(
      join(root, "docs/triage/open-issue-priority-clusters-20260728.json"),
      "utf8",
    );
    const markdown = readFileSync(
      join(root, "docs/triage/open-issue-priority-clusters-20260728.md"),
      "utf8",
    );
    expect(JSON.parse(json).counts.total).toBe(87);
    expect(markdown).toContain("| 4 | 83 | 87 |");

    expect(runPriorityClusterCli(["check"], root, output().io)).toBe(0);
    expect(
      runPriorityClusterCli(["render", "--check"], root, output().io),
    ).toBe(0);
    expect(
      runPriorityClusterCli(["generate", "--write"], root, output().io),
    ).toBe(0);
    expect(
      readFileSync(
        join(root, "docs/triage/open-issue-priority-clusters-20260728.json"),
        "utf8",
      ),
    ).toBe(json);
    expect(
      readFileSync(
        join(root, "docs/triage/open-issue-priority-clusters-20260728.md"),
        "utf8",
      ),
    ).toBe(markdown);
  });

  it("fails closed when either generated artifact drifts", () => {
    const root = fixtureRoot();
    expect(
      runPriorityClusterCli(["generate", "--write"], root, output().io),
    ).toBe(0);
    writeFileSync(
      join(root, "docs/triage/open-issue-priority-clusters-20260728.md"),
      "drift\n",
    );

    const check = output();
    expect(runPriorityClusterCli(["check"], root, check.io)).toBe(1);
    expect(check.stdout).toEqual([]);
    expect(check.stderr.join("")).toBe("INVALID generated-artifact-drift\n");
  });

  it("rejects unknown commands and path overrides", () => {
    const root = fixtureRoot();
    for (const args of [
      [],
      ["generate"],
      ["render"],
      ["render", "--write"],
      ["check", "--registry", "/tmp/private.json"],
      ["snapshot-owner-prs"],
    ]) {
      const result = output();
      expect(runPriorityClusterCli(args, root, result.io)).toBe(2);
      expect(result.stdout).toEqual([]);
      expect(result.stderr.join("")).toBe("INCONCLUSIVE invalid-arguments\n");
    }
  });
});
