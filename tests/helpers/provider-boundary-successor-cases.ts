export const SECRET_ASSIGNMENT_KEYS = [
  'token',
  'password',
  'credential',
  'session',
  'api_key',
] as const;

export const SAME_FIELD_ASSIGNMENT_SEPARATORS = [',', ';', '&', '|'] as const;

export const EMPTY_VALUE_KINDS = ['empty', 'whitespace-empty'] as const;
export const SPACING_KINDS = ['tight', 'after-separator', 'around-assignment'] as const;
export const SECOND_VALUE_KINDS = ['unquoted', 'quoted'] as const;

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

function assignmentCase(row: PairwiseRow, index: number, family: string) {
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
  const source = assignmentSource(
    outerKey,
    innerKey,
    separator,
    emptyKind,
    spacingKind,
    secondValueKind,
  );

  return {
    caseName: `${family} ${index}: ${outerKey}/${innerKey}/${separator}/`
      + `${emptyKind}/${spacingKind}/${secondValueKind}`,
    source,
    outerKey,
    innerKey,
    separator,
    emptyKind,
    spacingKind,
    secondValueKind,
    separatorEdgeSplit: source.indexOf(separator) + 1,
    pairKeys: pairKeys(row),
  };
}

export const EMPTY_ASSIGNMENT_PAIRWISE_CASES = deterministicPairwiseRows(
  PAIRWISE_AXES.map((axis) => axis.length),
).map((row, index) => assignmentCase(row, index, 'pairwise'));

export const EMPTY_ASSIGNMENT_FULL_CARTESIAN_CASES = cartesianIndices(
  PAIRWISE_AXES.map((axis) => axis.length),
).map((row, index) => assignmentCase(row, index, 'cartesian'));

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
    const identityStart = marker === 'Bearer'
      ? markerOffset + 'Bearer '.length
      : markerOffset;
    return {
      assignment,
      caseName: `nested case ${index}`,
      family: marker === 'Bearer' ? 'bearer' : 'known-token',
      nestedGrammarStart: markerOffset,
      identityStart,
      seamRelativeIndex: markerOffset + marker.length,
    };
  },
);

export const NESTED_OWNERSHIP_COORDINATE_CASES = NESTED_KEYLIKE_SEAM_CASES.flatMap(
  (seamCase) => [
    {
      ...seamCase,
      coordinate: 'nestedGrammarStart' as const,
      coordinateRelativeIndex: seamCase.nestedGrammarStart,
    },
    {
      ...seamCase,
      coordinate: 'identityStart' as const,
      coordinateRelativeIndex: seamCase.identityStart,
    },
  ],
);

export const NONEMPTY_PAIRWISE_CONTROLS = EMPTY_ASSIGNMENT_PAIRWISE_CASES.map(
  ({ caseName, source, separator }) => {
    const nonemptySource = source.replace(/^[a-z_]+=\s*/u, (prefix) => `${prefix}alpha`);
    return {
      caseName: `nonempty control for ${caseName}`,
      source: nonemptySource,
      secretCount: 2,
      separatorEdgeSplits: [nonemptySource.indexOf(separator) + 1],
    };
  },
);

export const ORDINARY_PUNCTUATION_CONTROLS = SECRET_ASSIGNMENT_KEYS.flatMap(
  (key) => SAME_FIELD_ASSIGNMENT_SEPARATORS.map((separator) => {
    const source = `${key}=alpha${separator}ordinary`;
    return {
      caseName: `${key} followed by ordinary punctuation ${separator}`,
      source,
      secretCount: 1,
      separatorEdgeSplits: [source.indexOf(separator) + 1],
    };
  }),
);

export const MULTIPLE_REAL_ASSIGNMENT_CONTROLS = SECRET_ASSIGNMENT_KEYS.map(
  (outerKey, index) => {
    const source = `${outerKey}=alpha,${SECRET_ASSIGNMENT_KEYS[(index + 1) % 5]}=beta;`
      + `${SECRET_ASSIGNMENT_KEYS[(index + 2) % 5]}=gamma`;
    return {
      caseName: `three real assignments beginning with ${outerKey}`,
      source,
      secretCount: 3,
      separatorEdgeSplits: [source.indexOf(',') + 1, source.indexOf(';') + 1],
    };
  },
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
