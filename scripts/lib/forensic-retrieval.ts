import path from 'node:path';

import { redactText } from '../../src/lib/redaction-text.ts';

export interface NormalizedRetrievalText {
  readonly raw: string;
  readonly normalized: string;
  readonly tokens: readonly string[];
}

export interface NgramWeights {
  readonly unigram: number;
  readonly bigram: number;
  readonly trigram: number;
  readonly character: number;
}

export interface NearDuplicateWeights {
  readonly unigram: number;
  readonly character: number;
  readonly tokenSort: number;
  readonly tokenSet: number;
}

export interface WeightedNgramResult {
  readonly score: number;
  readonly proof: false;
  readonly components: {
    readonly unigram: number | null;
    readonly bigram: number | null;
    readonly trigram: number | null;
    readonly character: number | null;
  };
}

export interface FuzzySimilarity {
  readonly damerauLevenshtein: number;
  readonly jaroWinkler: number;
  readonly tokenSort: number;
  readonly tokenSet: number;
  readonly combined: number;
  readonly proof: false;
}

export interface ForensicDocument {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly timestampMs: number | null;
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

export interface RankedForensicDocument {
  readonly id: string;
  readonly score: number;
  readonly scores: {
    readonly bm25: number;
    readonly tfidf: number;
    readonly lexical: number;
    readonly fuzzy: number;
    readonly exactEntity: number;
    readonly temporal: number;
  };
  readonly reasons: readonly string[];
}

export type EntityKind =
  | 'commit'
  | 'error'
  | 'filename'
  | 'flag'
  | 'path'
  | 'session'
  | 'symbol'
  | 'url';

export type ExtractedEntities = Readonly<Record<EntityKind, readonly string[]>>;

export interface ArtifactAlias {
  readonly canonical: string;
  readonly aliases: readonly string[];
}

export interface ArtifactGraph {
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: 'document' | 'entity';
  }[];
  readonly edges: readonly {
    readonly source: string;
    readonly target: string;
    readonly relation: 'references';
  }[];
}

export type ForensicFindingCode =
  | 'FORENSIC_JSONL_MALFORMED_RECORD'
  | 'FORENSIC_JSONL_INVALID_UTF8'
  | 'FORENSIC_JSONL_RECORD_BYTE_LIMIT'
  | 'FORENSIC_JSONL_UNSUPPORTED_RECORD'
  | 'FORENSIC_JSONL_TRUNCATED_TAIL'
  | 'FORENSIC_SOURCE_BYTE_LIMIT';

export interface ParsedJsonLine {
  readonly sourceId: string;
  readonly line: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly value: unknown;
}

export interface ForensicFinding {
  readonly code: ForensicFindingCode;
  readonly sourceId: string;
  readonly line: number | null;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export const FORENSIC_RETRIEVAL_CONFIGURATION = Object.freeze({
  normalization: Object.freeze({
    unicode: 'NFKC',
    locale: 'en-US',
    pathSeparators: 'posix',
    identifierSplitting: true,
    punctuationCollapsed: true,
  }),
  ngram: Object.freeze({
    tokenOrders: Object.freeze([1, 2, 3]),
    characterOrders: Object.freeze([3, 4, 5]),
    weights: Object.freeze({
      unigram: 0.15,
      bigram: 0.25,
      trigram: 0.3,
      character: 0.3,
    }),
  }),
  fuzzy: Object.freeze({
    metrics: Object.freeze([
      'damerau-levenshtein',
      'jaro-winkler',
      'token-sort',
      'token-set',
    ]),
    combination: 'equal-mean',
    proof: false,
  }),
  ranking: Object.freeze({
    bm25: 0.4,
    tfidf: 0.2,
    lexical: 0.15,
    fuzzy: 0.05,
    exactEntity: 0.15,
    temporal: 0.05,
    titleBoost: 0.05,
    exactFieldBoosts: Object.freeze({ path: 5, commit: 5, symbol: 4, error: 4 }),
  }),
  nearDuplicate: Object.freeze({
    weights: Object.freeze({ unigram: 1, character: 1, tokenSort: 1, tokenSet: 1 }),
    proof: false,
  }),
});

const DEFAULT_NGRAM_WEIGHTS: NgramWeights = FORENSIC_RETRIEVAL_CONFIGURATION.ngram.weights;

const DEFAULT_NEAR_DUPLICATE_WEIGHTS: NearDuplicateWeights =
  FORENSIC_RETRIEVAL_CONFIGURATION.nearDuplicate.weights;

const ENTITY_KINDS: readonly EntityKind[] = Object.freeze([
  'commit',
  'error',
  'filename',
  'flag',
  'path',
  'session',
  'symbol',
  'url',
]);

function round(value: number): number {
  return Number(value.toFixed(6));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

export function normalizeRetrievalText(raw: string): NormalizedRetrievalText {
  const normalized = raw
    .normalize('NFKC')
    .replace(/\\/g, '/')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\//g, ' / ')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}/]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = normalized.split(' ').filter((token) => token.length > 0 && token !== '/');
  return { raw, normalized, tokens };
}

function tokenNgrams(tokens: readonly string[], size: number): Set<string> {
  const grams = new Set<string>();
  if (tokens.length < size) return grams;
  for (let index = 0; index <= tokens.length - size; index += 1) {
    grams.add(tokens.slice(index, index + size).join(' '));
  }
  return grams;
}

function characterNgrams(value: string, size: number): Set<string> {
  const normalized = normalizeRetrievalText(value).tokens.join(' ');
  const grams = new Set<string>();
  if (normalized.length < size) {
    if (normalized.length > 0) grams.add(normalized);
    return grams;
  }
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function weightedNgramSimilarity(
  left: string,
  right: string,
  weights: NgramWeights = DEFAULT_NGRAM_WEIGHTS,
): WeightedNgramResult {
  if (Object.values(weights).some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new RangeError('n-gram weights must be non-negative finite numbers');
  }
  const weightTotal = weights.unigram + weights.bigram + weights.trigram + weights.character;
  if (!Number.isFinite(weightTotal) || weightTotal <= 0) {
    throw new RangeError('n-gram weights must have a positive finite total');
  }
  const leftTokens = normalizeRetrievalText(left).tokens;
  const rightTokens = normalizeRetrievalText(right).tokens;
  const leftCharacters = leftTokens.join(' ');
  const rightCharacters = rightTokens.join(' ');
  const characterSizes = [3, 4, 5].filter((size) =>
    leftCharacters.length >= size && rightCharacters.length >= size);
  const components = {
    unigram: leftTokens.length > 0 && rightTokens.length > 0
      ? jaccard(new Set(leftTokens), new Set(rightTokens))
      : null,
    bigram: leftTokens.length >= 2 && rightTokens.length >= 2
      ? jaccard(tokenNgrams(leftTokens, 2), tokenNgrams(rightTokens, 2))
      : null,
    trigram: leftTokens.length >= 3 && rightTokens.length >= 3
      ? jaccard(tokenNgrams(leftTokens, 3), tokenNgrams(rightTokens, 3))
      : null,
    character: characterSizes.length > 0
      ? average(characterSizes.map((size) =>
          jaccard(characterNgrams(left, size), characterNgrams(right, size))))
      : null,
  };
  const weighted: readonly [number | null, number][] = [
    [components.unigram, weights.unigram],
    [components.bigram, weights.bigram],
    [components.trigram, weights.trigram],
    [components.character, weights.character],
  ];
  let scoreTotal = 0;
  let availableWeight = 0;
  for (const [component, weight] of weighted) {
    if (component === null || weight === 0) continue;
    scoreTotal += component * weight;
    availableWeight += weight;
  }
  const score = availableWeight === 0 ? 0 : scoreTotal / availableWeight;
  return { score: round(score), proof: false, components };
}

function damerauLevenshteinDistance(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0));
  for (let row = 0; row <= a.length; row += 1) matrix[row]![0] = row;
  for (let column = 0; column <= b.length; column += 1) matrix[0]![column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = a[row - 1] === b[column - 1] ? 0 : 1;
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + substitution,
      );
      if (
        row > 1 &&
        column > 1 &&
        a[row - 1] === b[column - 2] &&
        a[row - 2] === b[column - 1]
      ) {
        matrix[row]![column] = Math.min(
          matrix[row]![column]!,
          matrix[row - 2]![column - 2]! + 1,
        );
      }
    }
  }
  return matrix[a.length]![b.length]!;
}

function normalizedEditSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const longest = Math.max([...left].length, [...right].length);
  if (longest === 0) return 1;
  return Math.max(0, 1 - damerauLevenshteinDistance(left, right) / longest);
}

function jaroSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const radius = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatched = Array<boolean>(left.length).fill(false);
  const rightMatched = Array<boolean>(right.length).fill(false);
  let matches = 0;
  for (let index = 0; index < left.length; index += 1) {
    const start = Math.max(0, index - radius);
    const end = Math.min(index + radius + 1, right.length);
    for (let candidate = start; candidate < end; candidate += 1) {
      if (rightMatched[candidate] || left[index] !== right[candidate]) continue;
      leftMatched[index] = true;
      rightMatched[candidate] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  const leftSequence = [...left].filter((_value, index) => leftMatched[index]);
  const rightSequence = [...right].filter((_value, index) => rightMatched[index]);
  let transpositions = 0;
  for (let index = 0; index < leftSequence.length; index += 1) {
    if (leftSequence[index] !== rightSequence[index]) transpositions += 1;
  }
  return (
    matches / left.length +
    matches / right.length +
    (matches - transpositions / 2) / matches
  ) / 3;
}

function jaroWinklerSimilarity(left: string, right: string): number {
  const jaro = jaroSimilarity(left, right);
  let prefix = 0;
  while (prefix < 4 && left[prefix] !== undefined && left[prefix] === right[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function stemForFuzzy(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function bestTokenCoverage(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const directional = (source: readonly string[], target: readonly string[]) => average(
    source.map((token) => Math.max(...target.map((candidate) =>
      normalizedEditSimilarity(stemForFuzzy(token), stemForFuzzy(candidate))))),
  );
  return Math.min(directional(left, right), directional(right, left));
}

export function fuzzySimilarity(left: string, right: string): FuzzySimilarity {
  const leftNormalized = normalizeRetrievalText(left);
  const rightNormalized = normalizeRetrievalText(right);
  const compactLeft = leftNormalized.tokens.join(' ');
  const compactRight = rightNormalized.tokens.join(' ');
  const damerauLevenshtein = normalizedEditSimilarity(compactLeft, compactRight);
  const jaroWinkler = jaroWinklerSimilarity(compactLeft, compactRight);
  const tokenSort = normalizedEditSimilarity(
    [...leftNormalized.tokens].sort().join(' '),
    [...rightNormalized.tokens].sort().join(' '),
  );
  const tokenSet = bestTokenCoverage(leftNormalized.tokens, rightNormalized.tokens);
  return {
    damerauLevenshtein: round(damerauLevenshtein),
    jaroWinkler: round(jaroWinkler),
    tokenSort: round(tokenSort),
    tokenSet: round(tokenSet),
    combined: round(average([damerauLevenshtein, jaroWinkler, tokenSort, tokenSet])),
    proof: false,
  };
}

function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return frequencies;
}

function inverseDocumentFrequencies(tokenSets: readonly ReadonlySet<string>[]): Map<string, number> {
  const documentFrequencies = new Map<string, number>();
  for (const tokens of tokenSets) {
    for (const token of tokens) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
    }
  }
  const result = new Map<string, number>();
  for (const [token, frequency] of documentFrequencies) {
    result.set(token, Math.log((tokenSets.length + 1) / (frequency + 1)) + 1);
  }
  return result;
}

function bm25Score(
  queryTokens: readonly string[],
  documentTokens: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  averageDocumentLength: number,
): number {
  const frequencies = termFrequencies(documentTokens);
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of new Set(queryTokens)) {
    const frequency = frequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    const containing = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - containing + 0.5) / (containing + 0.5));
    const denominator = frequency + k1 * (
      1 - b + b * documentTokens.length / Math.max(1, averageDocumentLength)
    );
    score += idf * ((frequency * (k1 + 1)) / denominator);
  }
  return score;
}

function tfidfCosine(
  queryTokens: readonly string[],
  documentTokens: readonly string[],
  idf: ReadonlyMap<string, number>,
): number {
  const queryFrequencies = termFrequencies(queryTokens);
  const documentFrequencies = termFrequencies(documentTokens);
  const terms = new Set([...queryFrequencies.keys(), ...documentFrequencies.keys()]);
  let dot = 0;
  let queryNorm = 0;
  let documentNorm = 0;
  for (const term of terms) {
    const weight = idf.get(term) ?? 1;
    const queryValue = (queryFrequencies.get(term) ?? 0) * weight;
    const documentValue = (documentFrequencies.get(term) ?? 0) * weight;
    dot += queryValue * documentValue;
    queryNorm += queryValue ** 2;
    documentNorm += documentValue ** 2;
  }
  if (queryNorm === 0 || documentNorm === 0) return 0;
  return dot / Math.sqrt(queryNorm * documentNorm);
}

function fieldValues(document: ForensicDocument, field: string): readonly string[] {
  return document.fields[field] ?? [];
}

function exactEntityScore(
  document: ForensicDocument,
  queryEntities: ExtractedEntities,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  for (const value of queryEntities.commit) {
    if (fieldValues(document, 'commit').includes(value) || document.text.includes(value)) {
      score += 5;
      reasons.push('exact-commit');
    }
  }
  for (const value of queryEntities.path) {
    if (fieldValues(document, 'path').includes(value) || document.text.includes(value)) {
      score += 5;
      reasons.push('exact-path');
    }
  }
  for (const value of queryEntities.symbol) {
    if (fieldValues(document, 'symbol').includes(value) || document.text.includes(value)) {
      score += 4;
      reasons.push('exact-symbol');
    }
  }
  for (const value of queryEntities.error) {
    if (fieldValues(document, 'error').includes(value) || document.text.includes(value)) {
      score += 4;
      reasons.push('exact-error');
    }
  }
  return { score, reasons: uniqueSorted(reasons) };
}

export function rankDocuments(
  documents: readonly ForensicDocument[],
  query: string,
  options: { readonly nowMs: number },
): RankedForensicDocument[] {
  if (!Number.isFinite(options.nowMs)) {
    throw new RangeError('nowMs must be an explicit finite observation time');
  }
  const normalizedDocuments = documents.map((document) => normalizeRetrievalText(
    `${document.title} ${document.text}`,
  ));
  const tokenSets = normalizedDocuments.map((document) => new Set(document.tokens));
  const idf = inverseDocumentFrequencies(tokenSets);
  const queryTokens = normalizeRetrievalText(query).tokens;
  const documentFrequency = new Map<string, number>();
  for (const term of new Set(queryTokens)) {
    documentFrequency.set(term, tokenSets.filter((tokens) => tokens.has(term)).length);
  }
  const averageDocumentLength = average(normalizedDocuments.map((row) => row.tokens.length));
  const queryEntities = extractEntities(query);
  const nowMs = options.nowMs;
  const ranked = documents.map((document, index): RankedForensicDocument => {
    const normalized = normalizedDocuments[index]!;
    const bm25 = bm25Score(
      queryTokens,
      normalized.tokens,
      documentFrequency,
      documents.length,
      averageDocumentLength,
    );
    const tfidf = tfidfCosine(queryTokens, normalized.tokens, idf);
    const lexical = weightedNgramSimilarity(query, `${document.title} ${document.text}`).score;
    const fuzzy = fuzzySimilarity(query, document.title).combined;
    const exact = exactEntityScore(document, queryEntities);
    const ageDays = document.timestampMs === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, nowMs - document.timestampMs) / 86_400_000;
    const temporal = Number.isFinite(ageDays) ? 1 / (1 + ageDays) : 0;
    const titleBoost = normalizeRetrievalText(document.title).tokens.some((token) => queryTokens.includes(token))
      ? 2
      : 0;
    const weights = FORENSIC_RETRIEVAL_CONFIGURATION.ranking;
    const score = weights.bm25 * bm25 + weights.tfidf * tfidf + weights.lexical * lexical +
      weights.fuzzy * fuzzy + weights.exactEntity * exact.score + weights.temporal * temporal +
      weights.titleBoost * titleBoost;
    return {
      id: document.id,
      score: round(score),
      scores: {
        bm25: round(bm25),
        tfidf: round(tfidf),
        lexical: round(lexical),
        fuzzy: round(fuzzy),
        exactEntity: exact.score,
        temporal: round(temporal),
      },
      reasons: exact.reasons,
    };
  });
  return ranked.sort((left, right) => right.score - left.score || compareText(left.id, right.id));
}

function matches(text: string, expression: RegExp): string[] {
  return [...text.matchAll(expression)].map((match) => match[0]!);
}

export function extractEntities(text: string): ExtractedEntities {
  const url = matches(text, /https?:\/\/[^\s<>"'`]+/gu).map((value) => value.replace(/[),.;]+$/u, ''));
  const session = matches(
    text,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
  ).map((value) => value.toLowerCase());
  const commit = matches(text, /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/giu)
    .map((value) => value.toLowerCase());
  const pathValues = matches(
    text,
    /\b(?:src|tests|scripts|docs|deploy|console)\/[A-Za-z0-9_.@/-]+/gu,
  ).map((value) => value.replace(/[),.;:]+$/u, ''));
  const flag = matches(text, /--[a-z][a-z0-9-]*(?:=[^\s,;]+)?/giu);
  const error = matches(text, /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){2,}\b/gu);
  const symbol = matches(text, /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/gu);
  const filename = pathValues.map((value) => path.posix.basename(value));
  return {
    commit: uniqueSorted(commit),
    error: uniqueSorted(error),
    filename: uniqueSorted(filename),
    flag: uniqueSorted(flag),
    path: uniqueSorted(pathValues),
    session: uniqueSorted(session),
    symbol: uniqueSorted(symbol),
    url: uniqueSorted(url),
  };
}

export function buildArtifactGraph(
  documents: readonly ForensicDocument[],
  aliases: readonly ArtifactAlias[] = [],
): ArtifactGraph {
  const nodes: Array<{ id: string; kind: 'document' | 'entity' }> = documents
    .map((document) => ({ id: `document:${document.id}`, kind: 'document' as const }))
    .sort((left, right) => compareText(left.id, right.id));
  const edges: Array<{ source: string; target: string; relation: 'references' }> = [];
  const entityIds = new Set<string>();
  const orderedAliases = [...aliases].sort((left, right) => compareText(left.canonical, right.canonical));
  for (const alias of orderedAliases) {
    const entityId = `entity:${alias.canonical}`;
    for (const document of documents) {
      if (alias.aliases.some((value) => document.text.includes(value) || document.title.includes(value))) {
        entityIds.add(entityId);
        edges.push({ source: `document:${document.id}`, target: entityId, relation: 'references' });
      }
    }
  }
  for (const kind of ENTITY_KINDS) {
    for (const document of documents) {
      for (const value of extractEntities(`${document.title} ${document.text}`)[kind]) {
        const entityId = `entity:${kind}:${value}`;
        entityIds.add(entityId);
        edges.push({ source: `document:${document.id}`, target: entityId, relation: 'references' });
      }
    }
  }
  for (const id of [...entityIds].sort(compareText)) {
    nodes.push({ id, kind: 'entity' });
  }
  edges.sort((left, right) =>
    compareText(left.source, right.source) || compareText(left.target, right.target));
  return { nodes, edges };
}

export function parseJsonLines(
  input: Buffer,
  options: {
    readonly sourceId: string;
    readonly complete: boolean;
    readonly maxBytes?: number;
    readonly maxRecordBytes?: number;
    readonly acceptRecord?: (value: unknown) => boolean;
  },
): {
  readonly records: readonly ParsedJsonLine[];
  readonly findings: readonly ForensicFinding[];
  readonly complete: boolean;
  readonly bytesObserved: number;
  readonly sourceBytes: number;
} {
  const configuredMax = options.maxBytes ?? input.length;
  if (!Number.isSafeInteger(configuredMax) || configuredMax < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  const maxRecordBytes = options.maxRecordBytes ?? configuredMax;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 0) {
    throw new RangeError('maxRecordBytes must be a non-negative safe integer');
  }
  const observedLength = Math.min(input.length, configuredMax);
  const limited = observedLength < input.length;
  const observed = input.subarray(0, observedLength);
  const records: ParsedJsonLine[] = [];
  const findings: ForensicFinding[] = [];
  if (limited) {
    findings.push({
      code: 'FORENSIC_SOURCE_BYTE_LIMIT',
      sourceId: options.sourceId,
      line: null,
      byteStart: observedLength,
      byteEnd: input.length,
    });
  }

  let byteStart = 0;
  let line = 1;
  while (byteStart < observed.length) {
    const newline = observed.indexOf(0x0a, byteStart);
    const hasTerminator = newline !== -1;
    const byteEnd = hasTerminator ? newline + 1 : observed.length;
    const payloadEnd = hasTerminator ? newline : observed.length;
    if (!hasTerminator && (!options.complete || limited)) {
      findings.push({
        code: 'FORENSIC_JSONL_TRUNCATED_TAIL',
        sourceId: options.sourceId,
        line,
        byteStart,
        byteEnd,
      });
      break;
    }
    const recordBytes = observed.subarray(byteStart, payloadEnd);
    if (recordBytes.length > maxRecordBytes) {
      findings.push({
        code: 'FORENSIC_JSONL_RECORD_BYTE_LIMIT',
        sourceId: options.sourceId,
        line,
        byteStart,
        byteEnd,
      });
    } else {
      let raw: string | null = null;
      try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(recordBytes).trim();
      } catch {
        findings.push({
          code: 'FORENSIC_JSONL_INVALID_UTF8',
          sourceId: options.sourceId,
          line,
          byteStart,
          byteEnd,
        });
      }
      if (raw !== null && raw.length > 0) {
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          findings.push({
            code: 'FORENSIC_JSONL_MALFORMED_RECORD',
            sourceId: options.sourceId,
            line,
            byteStart,
            byteEnd,
          });
          value = undefined;
        }
        if (value !== undefined) {
          if (options.acceptRecord && !options.acceptRecord(value)) {
            findings.push({
              code: 'FORENSIC_JSONL_UNSUPPORTED_RECORD',
              sourceId: options.sourceId,
              line,
              byteStart,
              byteEnd,
            });
          } else {
            records.push({ sourceId: options.sourceId, line, byteStart, byteEnd, value });
          }
        }
      }
    }
    byteStart = byteEnd;
    line += 1;
  }
  return {
    records,
    findings,
    complete: options.complete && !limited && findings.length === 0,
    bytesObserved: observed.length,
    sourceBytes: input.length,
  };
}

export function sanitizeEvidenceText(raw: string): {
  readonly text: string;
  readonly categories: readonly string[];
} {
  const categories = new Set<string>();
  let text = raw;
  text = text.replace(/\/(?:Users|home)\/[^/\s]+(?=\/)/gu, () => {
    categories.add('home_path');
    return '$HOME';
  });
  text = text.replace(/\/(?:private\/tmp|tmp|var\/folders)\/[^\s"'`]+/gu, () => {
    categories.add('local_path');
    return '[REDACTED_LOCAL_PATH]';
  });
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, () => {
    categories.add('email');
    return '[REDACTED_EMAIL]';
  });
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
    () => {
      categories.add('session');
      return '[REDACTED_SESSION]';
    },
  );
  text = text.replace(
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local\b/giu,
    () => {
      categories.add('host');
      return '[REDACTED_HOST]';
    },
  );
  text = text.replace(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/gu, () => {
    categories.add('phone');
    return '[REDACTED_PHONE]';
  });
  // Classify before projection so the evidence record retains the existing
  // category contract while the shared BOT ERRORS redactor owns the mutation.
  if (/\b(?:Authorization:\s*)?Bearer\s+[A-Za-z0-9._~+/-]+/iu.test(text)) {
    categories.add('credential');
  }
  if (/\b(?:api[_-]?key|token|secret)\s*[=:]\s*['"]?[A-Za-z0-9._~+/-]{24,}['"]?/iu.test(text)) {
    categories.add('opaque_secret');
  }
  text = redactText(text);
  return { text, categories: uniqueSorted(categories) };
}

export function detectNearDuplicates(
  documents: readonly { readonly id: string; readonly text: string }[],
  options: {
    readonly threshold: number;
    readonly weights?: NearDuplicateWeights;
  },
): readonly {
  readonly leftId: string;
  readonly rightId: string;
  readonly score: number;
  readonly components: {
    readonly unigram: number | null;
    readonly character: number | null;
    readonly tokenSort: number | null;
    readonly tokenSet: number | null;
  };
  readonly proof: false;
}[] {
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) {
    throw new RangeError('near-duplicate threshold must be between zero and one');
  }
  const weights = options.weights ?? DEFAULT_NEAR_DUPLICATE_WEIGHTS;
  if (Object.values(weights).some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new RangeError('near-duplicate weights must be non-negative finite numbers');
  }
  const candidates: Array<{
    leftId: string;
    rightId: string;
    score: number;
    components: {
      unigram: number | null;
      character: number | null;
      tokenSort: number | null;
      tokenSet: number | null;
    };
    proof: false;
  }> = [];
  for (let left = 0; left < documents.length; left += 1) {
    for (let right = left + 1; right < documents.length; right += 1) {
      const leftText = documents[left]!.text;
      const rightText = documents[right]!.text;
      const leftNormalized = normalizeRetrievalText(leftText);
      const rightNormalized = normalizeRetrievalText(rightText);
      const tokensAvailable = leftNormalized.tokens.length > 0 && rightNormalized.tokens.length > 0;
      const charactersAvailable = leftNormalized.tokens.join(' ').length >= 3 &&
        rightNormalized.tokens.join(' ').length >= 3;
      const lexical = weightedNgramSimilarity(leftText, rightText);
      const fuzzy = fuzzySimilarity(leftText, rightText);
      const components = {
        unigram: tokensAvailable ? round(lexical.components.unigram ?? 0) : null,
        character: charactersAvailable ? round(lexical.components.character ?? 0) : null,
        tokenSort: tokensAvailable ? fuzzy.tokenSort : null,
        tokenSet: tokensAvailable ? fuzzy.tokenSet : null,
      };
      const weightedComponents: readonly [number | null, number][] = [
        [components.unigram, weights.unigram],
        [components.character, weights.character],
        [components.tokenSort, weights.tokenSort],
        [components.tokenSet, weights.tokenSet],
      ];
      let weightedScore = 0;
      let availableWeight = 0;
      for (const [component, weight] of weightedComponents) {
        if (component === null || weight === 0) continue;
        weightedScore += component * weight;
        availableWeight += weight;
      }
      const score = round(availableWeight === 0 ? 0 : weightedScore / availableWeight);
      if (score >= options.threshold) {
        candidates.push({
          leftId: documents[left]!.id,
          rightId: documents[right]!.id,
          score,
          components,
          proof: false,
        });
      }
    }
  }
  return candidates.sort((left, right) =>
    right.score - left.score || compareText(left.leftId, right.leftId) || compareText(left.rightId, right.rightId));
}

export type LifecycleKind =
  | 'plan'
  | 'edit'
  | 'test_failed'
  | 'test_changed'
  | 'test_passed'
  | 'verification'
  | 'commit'
  | 'claim_fixed'
  | 'rediscovered';

export function detectLifecycleAnomalies(events: readonly {
  readonly workstream: string;
  readonly kind: LifecycleKind;
  readonly atMs: number;
}[]): readonly {
  readonly code:
    | 'FORENSIC_COMMIT_WITHOUT_VERIFICATION'
    | 'FORENSIC_POST_FIX_REDISCOVERY'
    | 'FORENSIC_TEST_CHANGED_AFTER_FAILURE';
  readonly workstream: string;
  readonly atMs: number;
}[] {
  const streams = new Map<string, typeof events[number][]>();
  for (const event of events) {
    const stream = streams.get(event.workstream) ?? [];
    stream.push(event);
    streams.set(event.workstream, stream);
  }
  const findings: Array<{
    code:
      | 'FORENSIC_COMMIT_WITHOUT_VERIFICATION'
      | 'FORENSIC_POST_FIX_REDISCOVERY'
      | 'FORENSIC_TEST_CHANGED_AFTER_FAILURE';
    workstream: string;
    atMs: number;
  }> = [];
  for (const [workstream, unordered] of streams) {
    const stream = [...unordered].sort((left, right) => left.atMs - right.atMs);
    let verifiedSinceChange = false;
    let fixedClaimOpen = false;
    let failedTestOpen = false;
    let changedAfterFailureAt: number | null = null;
    for (const event of stream) {
      if (!Number.isFinite(event.atMs)) {
        throw new RangeError('lifecycle timestamps must be finite numbers');
      }
      switch (event.kind) {
        case 'edit':
          verifiedSinceChange = false;
          break;
        case 'verification':
          verifiedSinceChange = true;
          break;
        case 'commit':
          if (!verifiedSinceChange) {
            findings.push({
              code: 'FORENSIC_COMMIT_WITHOUT_VERIFICATION',
              workstream,
              atMs: event.atMs,
            });
          }
          verifiedSinceChange = false;
          break;
        case 'claim_fixed':
          fixedClaimOpen = true;
          break;
        case 'rediscovered':
          if (fixedClaimOpen) {
            findings.push({
              code: 'FORENSIC_POST_FIX_REDISCOVERY',
              workstream,
              atMs: event.atMs,
            });
            fixedClaimOpen = false;
          }
          break;
        case 'test_failed':
          failedTestOpen = true;
          changedAfterFailureAt = null;
          verifiedSinceChange = false;
          break;
        case 'test_changed':
          if (failedTestOpen && changedAfterFailureAt === null) {
            changedAfterFailureAt = event.atMs;
          }
          verifiedSinceChange = false;
          break;
        case 'test_passed':
          if (failedTestOpen && changedAfterFailureAt !== null) {
            findings.push({
              code: 'FORENSIC_TEST_CHANGED_AFTER_FAILURE',
              workstream,
              atMs: changedAfterFailureAt,
            });
          }
          failedTestOpen = false;
          changedAfterFailureAt = null;
          verifiedSinceChange = true;
          break;
        case 'plan':
          break;
        default: {
          const exhaustive: never = event.kind;
          throw new Error(`unsupported lifecycle kind: ${exhaustive}`);
        }
      }
    }
  }
  return findings;
}

export function summarizeAdaptivePasses(passes: readonly {
  readonly pass: number;
  readonly candidates: number;
  readonly newEvidence: number;
  readonly failedSources: number;
}[]): {
  readonly saturated: boolean;
  readonly reason: 'diminishing-return' | 'failed-source' | 'insufficient-passes' | 'material-yield';
  readonly marginalYield: readonly number[];
} {
  let previousPass = 0;
  for (const pass of passes) {
    if (!Number.isSafeInteger(pass.pass) || pass.pass <= previousPass) {
      throw new RangeError('adaptive pass numbers must be unique positive integers in ascending order');
    }
    for (const value of [pass.candidates, pass.newEvidence, pass.failedSources]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('adaptive pass counts must be non-negative safe integers');
      }
    }
    if (pass.newEvidence > pass.candidates) {
      throw new RangeError('adaptive pass newEvidence cannot exceed candidates');
    }
    previousPass = pass.pass;
  }
  const marginalYield = passes.map((pass) => round(
    pass.candidates === 0 ? 0 : pass.newEvidence / pass.candidates,
  ));
  if (passes.some((pass) => pass.failedSources > 0)) {
    return { saturated: false, reason: 'failed-source', marginalYield };
  }
  if (passes.length < 3) {
    return { saturated: false, reason: 'insufficient-passes', marginalYield };
  }
  const last = passes[passes.length - 1]!;
  const prior = passes[passes.length - 2]!;
  const diminishing = last.newEvidence <= 1 && last.newEvidence <= prior.newEvidence &&
    marginalYield[marginalYield.length - 1]! <= 0.05;
  return {
    saturated: diminishing,
    reason: diminishing ? 'diminishing-return' : 'material-yield',
    marginalYield,
  };
}
