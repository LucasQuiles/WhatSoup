import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { addPublicTriageRow } from "../../scripts/lib/open-issue-triage/publication-audit.ts";

const audit = `# Publication Audit

Unrelated prose stays byte-for-byte.

**Total classification rows:** 2

| Classification | Count |
|---|---:|
| PUBLIC | 1 |
| PRIVATE-ARCHIVE | 1 |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | 2 |

| Path | Classification | Rationale |
|---|---|---|
| \`docs/triage/reviews/existing.json\` | PUBLIC | Existing public row. |
| \`docs/work-index.md\` | PRIVATE-ARCHIVE | Existing private row. |
`;

describe("open issue publication audit updates", () => {
  it("inserts one sorted PUBLIC row and updates exact totals", () => {
    const result = addPublicTriageRow(
      audit,
      "docs/triage/reviews/batch-2522.json",
      "Body-free reviewed issue evidence batch.",
    );

    expect(result).toContain("Unrelated prose stays byte-for-byte.");
    expect(result).toContain("**Total classification rows:** 3");
    expect(result).toContain("| PUBLIC | 2 |");
    expect(result).toContain("| Total | 3 |");
    expect(result.indexOf("docs/triage/reviews/batch-2522.json")).toBeLessThan(
      result.indexOf("docs/triage/reviews/existing.json"),
    );
    expect(result.indexOf("docs/triage/reviews/existing.json")).toBeLessThan(
      result.indexOf("docs/work-index.md"),
    );
  });

  it("accepts one canonical per-issue review record path", () => {
    const path =
      "docs/triage/reviews/open-issue-refresh-20260728/2478.json";
    const result = addPublicTriageRow(
      audit,
      path,
      "Body-free reviewed issue evidence.",
    );

    expect(result).toContain(`| \`${path}\` | PUBLIC |`);
  });

  it("fails closed on duplicate paths or inconsistent declared counts", () => {
    expect(() =>
      addPublicTriageRow(
        audit,
        "docs/triage/reviews/existing.json",
        "Duplicate.",
      ),
    ).toThrow(/already exists/i);
    expect(() =>
      addPublicTriageRow(
        audit.replace("| PUBLIC | 1 |", "| PUBLIC | 2 |"),
        "docs/triage/reviews/batch-2522.json",
        "Body-free reviewed issue evidence batch.",
      ),
    ).toThrow(/count/i);
  });

  it("preserves the accepted real audit order while inserting in the local triage region", () => {
    const current = readFileSync(
      new URL("../../docs/publication-audit.md", import.meta.url),
      "utf8",
    );
    const path = "docs/triage/reviews/zz-open-issue-refresh-probe.json";
    const result = addPublicTriageRow(
      current,
      path,
      "Body-free reviewed issue evidence batch.",
    );
    expect(result).toContain(path);
    const rowPaths = (text: string) =>
      [
        ...text.matchAll(
          /^\| `([^`]+)` \| (?:PUBLIC|PRIVATE-ARCHIVE|SANITIZE|DELETE) \|/gm,
        ),
      ].map((match) => match[1]!);
    const beforeRows = rowPaths(current);
    const afterRows = rowPaths(result);

    expect(afterRows.filter((row) => row !== path)).toEqual(beforeRows);
    expect(afterRows).toHaveLength(beforeRows.length + 1);
    expect(
      result.indexOf(
        "docs/triage/open-issue-review-ledger.jsonl",
      ),
    ).toBeLessThan(result.indexOf(path));
    expect(result.indexOf(path)).toBeLessThan(
      result.indexOf("docs/work-index-repair-matrix.md"),
    );
  });

  it.each([
    [["Token gh", "p_abcdefghijklmnop."].join(""), /public|secret|redaction/i],
    [
      ["Contact operator", "@", "real-company.com."].join(""),
      /public|private|email/i,
    ],
    [
      ["Operator path /", "Users", "/privateoperator/project."].join(""),
      /public|private|path|home/i,
    ],
  ])("rejects unsafe PUBLIC rationale bytes: %s", (rationale, expected) => {
    expect(() =>
      addPublicTriageRow(
        audit,
        "docs/triage/reviews/batch-unsafe.json",
        rationale,
      ),
    ).toThrow(expected);
  });
});
