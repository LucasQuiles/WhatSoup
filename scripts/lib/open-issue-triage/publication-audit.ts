import { assertNoSecretLike } from "../../artifact-redaction.ts";
import { scanTextForPrivateLiterals } from "../../publication-guard.ts";
import { scanContentLines } from "../../repo-hygiene-guard.ts";

const CLASSIFICATIONS = [
  "PUBLIC",
  "PRIVATE-ARCHIVE",
  "SANITIZE",
  "DELETE",
] as const;
type Classification = (typeof CLASSIFICATIONS)[number];

interface AuditRow {
  index: number;
  line: string;
  path: string;
  classification: Classification;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function singleIndex(lines: string[], pattern: RegExp, label: string): number {
  const matches = lines
    .map((line, index) => (pattern.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new Error(`publication audit must contain exactly one ${label}`);
  }
  return matches[0]!;
}

function parseRows(lines: string[]): { headerIndex: number; rows: AuditRow[] } {
  const headerIndex = singleIndex(
    lines,
    /^\| Path \| Classification \| Rationale \|$/,
    "path table header",
  );
  if (lines[headerIndex + 1] !== "|---|---|---|") {
    throw new Error("publication audit path table delimiter is invalid");
  }
  const rows: AuditRow[] = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "") continue;
    const match =
      /^\| `([^`]+)` \| (PUBLIC|PRIVATE-ARCHIVE|SANITIZE|DELETE) \| ([^|]+) \|$/.exec(
        line,
      );
    if (match === null) {
      throw new Error(`publication audit path row ${index + 1} is malformed`);
    }
    rows.push({
      index,
      line,
      path: match[1]!,
      classification: match[2] as Classification,
    });
  }
  if (new Set(rows.map((row) => row.path)).size !== rows.length) {
    throw new Error("publication audit paths must be unique");
  }
  const triageRows = rows.filter((row) => row.path.startsWith("docs/triage/"));
  for (const [index, row] of triageRows.entries()) {
    if (index > 0 && compareUtf8(triageRows[index - 1]!.path, row.path) >= 0) {
      throw new Error("publication audit triage paths must be locally sorted");
    }
  }
  return { headerIndex, rows };
}

export function addPublicTriageRow(
  text: string,
  path: string,
  rationale: string,
): string {
  if (!text.endsWith("\n"))
    throw new Error("publication audit must end with LF");
  if (
    !/^docs\/triage\/(?:reviews\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\.json|\/[1-9]\d*\.json)|snapshots\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json)$/.test(
      path,
    )
  ) {
    throw new Error(
      "publication audit path is outside the fixed triage artifact subtrees",
    );
  }
  if (
    rationale.length === 0 ||
    rationale.length > 512 ||
    /[\n\r|`]/.test(rationale)
  ) {
    throw new Error("publication audit rationale is invalid");
  }

  const lines = text.slice(0, -1).split("\n");
  const { headerIndex, rows } = parseRows(lines);
  if (rows.some((row) => row.path === path)) {
    throw new Error(`publication audit row already exists for ${path}`);
  }
  const observedCounts = Object.fromEntries(
    CLASSIFICATIONS.map((classification) => [
      classification,
      rows.filter((row) => row.classification === classification).length,
    ]),
  ) as Record<Classification, number>;
  const total = rows.length;

  const totalDeclarationIndex = singleIndex(
    lines,
    /^\*\*Total classification rows:\*\* \d+$/,
    "total declaration",
  );
  const totalDeclaration = Number(
    /^\*\*Total classification rows:\*\* (\d+)$/.exec(
      lines[totalDeclarationIndex]!,
    )![1],
  );
  if (totalDeclaration !== total) {
    throw new Error(
      "publication audit total declaration does not match path row count",
    );
  }

  const countIndexes = new Map<Classification | "Total", number>();
  for (const classification of [...CLASSIFICATIONS, "Total"] as const) {
    const index = singleIndex(
      lines,
      new RegExp(`^\\| ${classification} \\| \\d+ \\|$`),
      `${classification} count row`,
    );
    const declared = Number(
      new RegExp(`^\\| ${classification} \\| (\\d+) \\|$`).exec(
        lines[index]!,
      )![1],
    );
    const expected =
      classification === "Total" ? total : observedCounts[classification];
    if (declared !== expected) {
      throw new Error(
        `publication audit ${classification} count does not match path rows`,
      );
    }
    countIndexes.set(classification, index);
  }

  const newLine = `| \`${path}\` | PUBLIC | ${rationale} |`;
  const triageRows = rows.filter((row) => row.path.startsWith("docs/triage/"));
  const nextTriageRow = triageRows.find(
    (row) => compareUtf8(path, row.path) < 0,
  );
  const insertionIndex =
    nextTriageRow?.index ??
    (triageRows.length > 0
      ? triageRows[triageRows.length - 1]!.index + 1
      : (rows.find((row) => compareUtf8(path, row.path) < 0)?.index ??
        headerIndex + 2 + rows.length));
  lines.splice(insertionIndex, 0, newLine);

  const shifted = (index: number): number =>
    index >= insertionIndex ? index + 1 : index;
  lines[shifted(totalDeclarationIndex)] =
    `**Total classification rows:** ${total + 1}`;
  for (const classification of CLASSIFICATIONS) {
    const index = shifted(countIndexes.get(classification)!);
    const count =
      observedCounts[classification] + (classification === "PUBLIC" ? 1 : 0);
    lines[index] = `| ${classification} | ${count} |`;
  }
  lines[shifted(countIndexes.get("Total")!)] = `| Total | ${total + 1} |`;
  const candidate = `${lines.join("\n")}\n`;
  const filePath = "docs/publication-audit.md";
  const existingPublicationIssues = scanTextForPrivateLiterals(filePath, text);
  const publicationIssues = scanTextForPrivateLiterals(filePath, candidate);
  const existingHygieneIssues = scanContentLines(
    text.split("\n").map((line, index) => ({
      filePath,
      line: index + 1,
      text: line,
    })),
  );
  const hygieneIssues = scanContentLines(
    candidate.split("\n").map((line, index) => ({
      filePath,
      line: index + 1,
      text: line,
    })),
  );
  const issueCounts = (issues: Array<{ code: string }>) =>
    new Map(
      [...new Set(issues.map((issue) => issue.code))].map((code) => [
        code,
        issues.filter((issue) => issue.code === code).length,
      ]),
    );
  const existingCounts = issueCounts([
    ...existingPublicationIssues,
    ...existingHygieneIssues,
  ]);
  const candidateCounts = issueCounts([...publicationIssues, ...hygieneIssues]);
  const newIssueCodes = [...candidateCounts]
    .filter(([code, count]) => count > (existingCounts.get(code) ?? 0))
    .map(([code]) => code);
  if (newIssueCodes.length > 0) {
    throw new Error(
      `PUBLIC publication audit rejected: ${newIssueCodes.join(", ")}`,
    );
  }
  assertNoSecretLike(candidate, "publication audit");
  return candidate;
}
