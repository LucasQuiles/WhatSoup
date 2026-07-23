export const SECRET_ASSIGNMENT_KEYS = [
  'token',
  'password',
  'credential',
  'session',
  'api_key',
] as const;

export const SAME_FIELD_ASSIGNMENT_SEPARATORS = [',', ';', '&', '|'] as const;

const EMPTY_VALUE_KINDS = ['empty', 'whitespace-empty'] as const;
const SPACING_KINDS = ['tight', 'after-separator', 'around-assignment'] as const;
const SECOND_VALUE_KINDS = ['unquoted', 'quoted'] as const;

const PAIRWISE_AXES = [
  SECRET_ASSIGNMENT_KEYS,
  SECRET_ASSIGNMENT_KEYS,
  SAME_FIELD_ASSIGNMENT_SEPARATORS,
  EMPTY_VALUE_KINDS,
  SPACING_KINDS,
  SECOND_VALUE_KINDS,
] as const;

type PairwiseRow = readonly number[];

function cartesianIndices(axisLengths: readonly number[]): number[][] {
  return axisLengths.reduce<number[][]>(
    (rows, length) => rows.flatMap((row) => (
      Array.from({ length }, (_, valueIndex) => [...row, valueIndex])
    )),
    [[]],
  );
}

function pairKeys(row: PairwiseRow): string[] {
  const keys: string[] = [];
  for (let leftAxis = 0; leftAxis < row.length; leftAxis += 1) {
    for (let rightAxis = leftAxis + 1; rightAxis < row.length; rightAxis += 1) {
      keys.push(`${leftAxis}:${row[leftAxis]}|${rightAxis}:${row[rightAxis]}`);
    }
  }
  return keys;
}

function deterministicPairwiseRows(axisLengths: readonly number[]): number[][] {
  const candidates = cartesianIndices(axisLengths);
  const uncovered = new Set(candidates.flatMap(pairKeys));
  const selected: number[][] = [];

  while (uncovered.size > 0) {
    let bestCandidate: number[] | undefined;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = pairKeys(candidate).filter((key) => uncovered.has(key)).length;
      if (score > bestScore) {
        bestCandidate = candidate;
        bestScore = score;
      }
    }
    if (!bestCandidate || bestScore <= 0) {
      throw new Error('deterministic pairwise generator could not cover every axis pair');
    }
    selected.push(bestCandidate);
    for (const key of pairKeys(bestCandidate)) uncovered.delete(key);
  }

  return selected;
}

function spacing(kind: (typeof SPACING_KINDS)[number]): {
  afterSeparator: string;
  beforeAssignment: string;
  afterAssignment: string;
} {
  if (kind === 'tight') {
    return { afterSeparator: '', beforeAssignment: '', afterAssignment: '' };
  }
  if (kind === 'after-separator') {
    return { afterSeparator: ' ', beforeAssignment: '', afterAssignment: '' };
  }
  return { afterSeparator: ' ', beforeAssignment: ' ', afterAssignment: ' ' };
}

function assignmentSource(
  outerKey: (typeof SECRET_ASSIGNMENT_KEYS)[number],
  innerKey: (typeof SECRET_ASSIGNMENT_KEYS)[number],
  separator: (typeof SAME_FIELD_ASSIGNMENT_SEPARATORS)[number],
  emptyKind: (typeof EMPTY_VALUE_KINDS)[number],
  spacingKind: (typeof SPACING_KINDS)[number],
  secondValueKind: (typeof SECOND_VALUE_KINDS)[number],
  firstValue = emptyKind === 'empty' ? '' : ' ',
): string {
  const selectedSpacing = spacing(spacingKind);
  const secondValue = secondValueKind === 'quoted' ? '"beta"' : 'beta';
  return `${outerKey}=${firstValue}${separator}${selectedSpacing.afterSeparator}`
    + `${innerKey}${selectedSpacing.beforeAssignment}=`
    + `${selectedSpacing.afterAssignment}${secondValue}`;
}

export const EMPTY_ASSIGNMENT_PAIRWISE_CASES = deterministicPairwiseRows(
  PAIRWISE_AXES.map((axis) => axis.length),
).map((row, index) => {
  const [
    outerKeyIndex,
    innerKeyIndex,
    separatorIndex,
    emptyKindIndex,
    spacingKindIndex,
    secondValueKindIndex,
  ] = row;
  const outerKey = SECRET_ASSIGNMENT_KEYS[outerKeyIndex]!;
  const innerKey = SECRET_ASSIGNMENT_KEYS[innerKeyIndex]!;
  const separator = SAME_FIELD_ASSIGNMENT_SEPARATORS[separatorIndex]!;
  const emptyKind = EMPTY_VALUE_KINDS[emptyKindIndex]!;
  const spacingKind = SPACING_KINDS[spacingKindIndex]!;
  const secondValueKind = SECOND_VALUE_KINDS[secondValueKindIndex]!;

  return {
    caseName: `pairwise ${index}: ${outerKey}/${innerKey}/${separator}/`
      + `${emptyKind}/${spacingKind}/${secondValueKind}`,
    source: assignmentSource(
      outerKey,
      innerKey,
      separator,
      emptyKind,
      spacingKind,
      secondValueKind,
    ),
    pairKeys: pairKeys(row),
  };
});

export const EXPECTED_PAIRWISE_KEYS = new Set(
  cartesianIndices(PAIRWISE_AXES.map((axis) => axis.length)).flatMap(pairKeys),
);

export const OBSERVED_PAIRWISE_KEYS = new Set(
  EMPTY_ASSIGNMENT_PAIRWISE_CASES.flatMap(({ pairKeys: keys }) => keys),
);

export const NESTED_KEYLIKE_SECRET_ASSIGNMENTS = [
  'password=xtoken=Bearer alpha',
  'password=x/password=Bearer alpha',
  'password="x token=Bearer alpha"',
  `password=xtoken=ghp_${'b'.repeat(16)}`,
  `password=x/token=ghp_${'c'.repeat(16)}`,
  `password="x token=ghp_${'d'.repeat(16)}"`,
] as const;

export const NESTED_KEYLIKE_FILLER_OFFSETS = [
  511,
  512,
  513,
  65_530,
  65_535,
  65_536,
  65_537,
] as const;

export const NESTED_KEYLIKE_SEAM_CASES = NESTED_KEYLIKE_SECRET_ASSIGNMENTS.map(
  (assignment, index) => {
    const marker = assignment.includes('Bearer') ? 'Bearer' : 'ghp_';
    const markerOffset = assignment.indexOf(marker);
    if (markerOffset < 0) throw new Error(`missing nested marker in case ${index}`);
    return {
      assignment,
      caseName: `nested case ${index}`,
      seamRelativeIndex: markerOffset + marker.length,
    };
  },
);

export const NONEMPTY_PAIRWISE_CONTROLS = EMPTY_ASSIGNMENT_PAIRWISE_CASES.map(
  ({ caseName, source }) => ({
    caseName: `nonempty control for ${caseName}`,
    source: source.replace(/^[a-z_]+=\s*/u, (prefix) => `${prefix}alpha`),
    secretCount: 2,
  }),
);

export const ORDINARY_PUNCTUATION_CONTROLS = SECRET_ASSIGNMENT_KEYS.flatMap(
  (key) => SAME_FIELD_ASSIGNMENT_SEPARATORS.map((separator) => ({
    caseName: `${key} followed by ordinary punctuation ${separator}`,
    source: `${key}=alpha${separator}ordinary`,
    secretCount: 1,
  })),
);

export const MULTIPLE_REAL_ASSIGNMENT_CONTROLS = SECRET_ASSIGNMENT_KEYS.map(
  (outerKey, index) => ({
    caseName: `three real assignments beginning with ${outerKey}`,
    source: `${outerKey}=alpha,${SECRET_ASSIGNMENT_KEYS[(index + 1) % 5]}=beta;`
      + `${SECRET_ASSIGNMENT_KEYS[(index + 2) % 5]}=gamma`,
    secretCount: 3,
  }),
);

export function everySplit(source: string): Array<{
  left: string;
  right: string;
  split: number;
}> {
  return Array.from({ length: source.length - 1 }, (_, index) => {
    const split = index + 1;
    return {
      left: source.slice(0, split),
      right: source.slice(split),
      split,
    };
  });
}
