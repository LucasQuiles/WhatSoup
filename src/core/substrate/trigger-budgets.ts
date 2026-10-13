/**
 * The single resource contract for durable substrate triggers.
 *
 * String limits are UTF-8 bytes. The limits protect admission, persisted-row
 * revalidation, child-process IPC, and the isolated `poll.sqlite` executor.
 * `poll.pinecone` is the only current provider-backed trigger; `top_k` bounds
 * its remote work. The other current kinds have no provider-spend dimension.
 */
export const TRIGGER_BUDGETS = {
  maxTextBytes: 4_096,
  maxTitleBytes: 256,
  maxPromptBytes: 4_096,
  maxReportTargetBytes: 512,
  maxDedupeKeyBytes: 256,
  maxMetadataBytes: 4_096,
  maxSpecBytes: 8_192,
  maxSpecDepth: 8,
  maxCollectionItems: 64,
  maxSqlBytes: 4_096,
  maxSqliteBinds: 32,
  maxSqliteBindBytes: 1_024,
  maxSqliteBindPayloadBytes: 4_096,
  maxSqliteRows: 10_000,
  maxSqliteOutputBytes: 2_048,
  maxSqliteWallTimeMs: 30_000,
  maxWorkerStdinBytes: 12_288,
  maxWorkerStdoutBytes: 2_048,
  maxWorkerStderrBytes: 2_048,
  maxRegexBytes: 512,
  maxSelectorBytes: 512,
  maxSelectorCombinators: 32,
  maxUrlBytes: 2_048,
  maxFilePathBytes: 1_024,
  maxCronBytes: 256,
  maxTimezoneBytes: 64,
  maxPineconeIndexBytes: 128,
  maxPineconeNamespaceBytes: 256,
  maxPineconeQueryBytes: 4_096,
  maxPineconeTopK: 100,
  maxBatchSize: 50,
  maxTickBudgetSeconds: 600,
  maxExecutionTimeoutSeconds: 300,
  maxConcurrentPerTick: 4,
  maxConsecutiveFailures: 5,
  maxConsecutiveForbiddenRejects: 3,
} as const;

export type SqliteJsonBind = null | number | string;

type SqlTokenKind = 'word' | 'identifier' | 'punctuation';

interface SqlToken {
  kind: SqlTokenKind;
  value: string;
  start: number;
  end: number;
}

function isSqlWordStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isSqlWordPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

/**
 * Tokenizes only the SQLite grammar features needed to identify the outer
 * statement. Quoted strings/identifiers and comments are deliberately opaque:
 * their text must not change the access decision. An unterminated quote or
 * comment is rejected rather than passed to SQLite.
 */
function sqliteTokens(sql: string): SqlToken[] | null {
  const tokens: SqlToken[] = [];
  let index = 0;
  const push = (kind: SqlTokenKind, value: string, start: number, end: number): void => {
    tokens.push({ kind, value, start, end });
  };
  const quoted = (delimiter: string, escapedDelimiter: string, kind: SqlTokenKind): boolean => {
    const start = index;
    index++;
    while (index < sql.length) {
      if (sql.startsWith(escapedDelimiter, index)) {
        index += escapedDelimiter.length;
        continue;
      }
      if (sql[index] === delimiter) {
        index++;
        push(kind, '', start, index);
        return true;
      }
      index++;
    }
    return false;
  };
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      if (close < 0) return null;
      index = close + 2;
      continue;
    }
    if (char === "'") {
      if (!quoted("'", "''", 'identifier')) return null;
      continue;
    }
    if (char === '"') {
      if (!quoted('"', '""', 'identifier')) return null;
      continue;
    }
    if (char === '`') {
      if (!quoted('`', '``', 'identifier')) return null;
      continue;
    }
    if (char === '[') {
      const start = index;
      const close = sql.indexOf(']', index + 1);
      if (close < 0) return null;
      index = close + 1;
      push('identifier', '', start, index);
    } else if (isSqlWordStart(char)) {
      const start = index++;
      while (index < sql.length && isSqlWordPart(sql[index])) index++;
      push('word', sql.slice(start, index).toUpperCase(), start, index);
    } else if (char === '(' || char === ')' || char === ',' || char === ';') {
      push('punctuation', char, index, index + 1);
      index++;
    } else {
      index++;
    }
  }
  return tokens;
}

function tokenIs(token: SqlToken | null | undefined, value: string): boolean {
  return token?.kind === 'word' && token.value === value;
}

function skipParenthesized(tokens: readonly SqlToken[], openAt: number): number | null {
  if (tokens[openAt]?.value !== '(') return null;
  let depth = 0;
  for (let index = openAt; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (value === '(') depth++;
    if (value === ')' && --depth === 0) return index + 1;
  }
  return null;
}

/** Returns the outer statement after zero or more non-recursive CTEs. */
function withOuterStatement(tokens: readonly SqlToken[]): SqlToken | null {
  let index = 1;
  if (tokenIs(tokens[index], 'RECURSIVE')) return null;
  while (index < tokens.length) {
    if (tokens[index]?.kind !== 'word' && tokens[index]?.kind !== 'identifier') return null;
    index++;
    if (tokens[index]?.value === '(') {
      const afterColumns = skipParenthesized(tokens, index);
      if (afterColumns === null) return null;
      index = afterColumns;
    }
    if (!tokenIs(tokens[index], 'AS')) return null;
    index++;
    if (tokenIs(tokens[index], 'NOT')) {
      if (!tokenIs(tokens[index + 1], 'MATERIALIZED')) return null;
      index += 2;
    } else if (tokenIs(tokens[index], 'MATERIALIZED')) {
      index++;
    }
    const afterQuery = skipParenthesized(tokens, index);
    if (afterQuery === null) return null;
    index = afterQuery;
    if (tokens[index]?.value === ',') {
      index++;
      continue;
    }
    return tokens[index] ?? null;
  }
  return null;
}

function normalizedReadOnlySql(sql: string): string | null {
  if (Buffer.byteLength(sql, 'utf8') > TRIGGER_BUDGETS.maxSqlBytes) return null;
  const tokens = sqliteTokens(sql);
  if (!tokens || tokens.length === 0) return null;
  const final = tokens[tokens.length - 1];
  const withoutTrailingSemicolon = final.value === ';' ? tokens.slice(0, -1) : tokens;
  if (withoutTrailingSemicolon.length === 0 || withoutTrailingSemicolon.some((token) => token.value === ';')) return null;
  const first = withoutTrailingSemicolon[0];
  const outer = tokenIs(first, 'WITH') ? withOuterStatement(withoutTrailingSemicolon) : first;
  if (!tokenIs(outer, 'SELECT')) return null;
  // Keep only the accepted statement body. A terminal semicolon may be followed
  // by whitespace or a comment, which must not become a second statement when
  // the child nests this query.
  return final.value === ';' ? sql.slice(0, final.start) + sql.slice(final.end) : sql;
}

/**
 * Allows exactly one non-recursive read query. This parser makes the decision
 * from SQLite tokens and outer-statement shape, never raw keyword substrings,
 * so keywords inside quoted text or comments stay inert.
 */
export function isSafeSqliteSql(sql: string): boolean {
  return normalizedReadOnlySql(sql) !== null;
}

/**
 * Wraps an admitted read query so SQLite emits one fixed scalar. The inner
 * LIMIT stops row production at `maxRows + 1`; the child compares that bounded
 * count to the requested cap without materializing caller-selected values.
 */
export function sqliteBoundedCountQuery(sql: string, maxRows: number): string | null {
  const normalized = normalizedReadOnlySql(sql);
  if (
    normalized === null
    || !Number.isInteger(maxRows)
    || maxRows <= 0
    || maxRows > TRIGGER_BUDGETS.maxSqliteRows
  ) return null;
  return `SELECT COUNT(*) AS row_count FROM (SELECT 1 FROM (${normalized}\n) AS trigger_source LIMIT ${maxRows + 1}) AS trigger_limited`;
}
