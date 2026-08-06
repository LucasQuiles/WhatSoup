import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertNoSecretLike } from "../../scripts/artifact-redaction.ts";
import {
  buildPriorityClusterInventory,
  canonicalPriorityClusterJson,
  parsePriorityClusterInventory,
  renderPriorityClusterMarkdown,
  validatePriorityClusterInventory,
} from "../../scripts/lib/open-issue-priority-clusters.ts";
import { scanTextForPrivateLiterals } from "../../scripts/publication-guard.ts";
import { scanContentLines } from "../../scripts/repo-hygiene-guard.ts";

const REGISTRY_TEXT = readFileSync(
  "docs/triage/open-issue-registry.json",
  "utf8",
);

describe("open issue priority clusters", () => {
  it("projects the sealed P0/P1 registry into an exact 15-cluster partition", () => {
    const inventory = buildPriorityClusterInventory(REGISTRY_TEXT);

    expect(inventory.source_registry_artifact_commit).toBe(
      "a18b17553c8cfcbaa07f1a57e7df1844171be955",
    );
    expect(inventory.source_registry_revision).toBe(
      "f0ece2d18883a66f04892a46669b3547e5bdf2b1",
    );
    expect(inventory.source_registry_sha256).toBe(
      "d07ea3ad9b50fc767482f31f3ecc43098459252fdd805c67ec88698d9d916923",
    );
    expect(inventory.counts).toEqual({
      P0: 4,
      P1: 83,
      total: 87,
      in_progress: 6,
      patch_ready: 9,
      conflict: 0,
      unclaimed: 72,
      clusters: 15,
    });
    expect(inventory.clusters).toHaveLength(15);

    const members = inventory.clusters.flatMap(
      (cluster) => cluster.member_issue_numbers,
    );
    expect(members).toHaveLength(87);
    expect(new Set(members)).toHaveLength(87);
  });

  it("serializes and renders deterministically", () => {
    const inventory = buildPriorityClusterInventory(REGISTRY_TEXT);

    expect(canonicalPriorityClusterJson(inventory)).toBe(
      canonicalPriorityClusterJson(inventory),
    );
    expect(renderPriorityClusterMarkdown(inventory)).toBe(
      renderPriorityClusterMarkdown(inventory),
    );
    expect(canonicalPriorityClusterJson(inventory).endsWith("\n")).toBe(true);
    expect(renderPriorityClusterMarkdown(inventory).endsWith("\n")).toBe(true);
  });

  it("rejects missing, duplicate, and non-priority assignments", () => {
    const inventory = buildPriorityClusterInventory(REGISTRY_TEXT);

    for (const mutate of [
      (value: typeof inventory) => {
        value.clusters[0]!.member_issue_numbers.shift();
      },
      (value: typeof inventory) => {
        value.clusters[1]!.member_issue_numbers.push(
          value.clusters[0]!.member_issue_numbers[0]!,
        );
        value.clusters[1]!.member_issue_numbers.sort(
          (left, right) => left - right,
        );
      },
      (value: typeof inventory) => {
        value.clusters[0]!.member_issue_numbers.push(1);
        value.clusters[0]!.member_issue_numbers.sort(
          (left, right) => left - right,
        );
      },
    ]) {
      const candidate = structuredClone(inventory);
      mutate(candidate);
      expect(() =>
        validatePriorityClusterInventory(candidate, REGISTRY_TEXT),
      ).toThrow();
    }
  });

  it("rejects unknown fields and binding tampering", () => {
    const inventory = buildPriorityClusterInventory(REGISTRY_TEXT);
    const unknown = {
      ...inventory,
      title: "PRIVATE_TITLE_SENTINEL",
    };
    expect(() => parsePriorityClusterInventory(unknown)).toThrow();

    const tampered = structuredClone(inventory);
    tampered.source_registry_sha256 = "0".repeat(64);
    expect(() =>
      validatePriorityClusterInventory(tampered, REGISTRY_TEXT),
    ).toThrow();
  });

  it("publishes only approved numeric and aggregate projections", () => {
    const inventory = buildPriorityClusterInventory(REGISTRY_TEXT);
    const json = canonicalPriorityClusterJson(inventory);
    const markdown = renderPriorityClusterMarkdown(inventory);
    const output = `${json}${markdown}`;
    const filePath =
      "docs/triage/open-issue-priority-clusters-20260728.json";

    for (const forbidden of [
      "title",
      "body",
      "path",
      "owner",
      "acceptance",
      "remediation",
      "evidence_summary",
      "/Users/",
      "~/",
    ]) {
      expect(output).not.toContain(forbidden);
    }
    expect(scanTextForPrivateLiterals(filePath, output)).toEqual([]);
    expect(
      scanContentLines(
        output.split("\n").map((text, index) => ({
          filePath,
          line: index + 1,
          text,
        })),
      ),
    ).toEqual([]);
    expect(() => assertNoSecretLike(output, "priority clusters")).not.toThrow();
  });
});
