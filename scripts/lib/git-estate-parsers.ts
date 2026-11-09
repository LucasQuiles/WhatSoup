import {
  compareText,
  GitEstateError,
  isFullObjectId,
  type EstateBranch,
  type EstateStash,
  type WorktreePorcelain,
  type WorktreeStatus,
} from './git-estate-model.ts';

const ORDINARY_XY = new Set([
  '.M', '.T', '.A', '.D',
  'M.', 'MM', 'MT', 'MD',
  'T.', 'TM', 'TT', 'TD',
  'A.', 'AM', 'AT', 'AD',
  'D.',
]);
const RENAME_XY = new Set([
  'R.', 'RM', 'RT', 'RD',
  'C.', 'CM', 'CT', 'CD',
  '.R', '.C',
]);
const UNMERGED_XY_PATTERN = /^(?:DD|AU|UD|UA|DU|AA|UU)$/;
const SUBMODULE_STATE_PATTERN = /^(?:N\.\.\.|S[.C][.M][.U])$/;
const FILE_MODE_PATTERN = /^[0-7]{6}$/;
const RENAME_SCORE_PATTERN = /^([RC])(?:100|[1-9]?\d)$/;

export function parseWorktreePorcelain(raw: string): WorktreePorcelain[] {
  const records: WorktreePorcelain[] = [];
  let current: (Partial<WorktreePorcelain> & { bare?: boolean }) | null = null;
  let phase: 'identity' | 'checkout' | 'annotations' = 'identity';
  if (!raw.endsWith('\0\0')) {
    throw new GitEstateError(
      'worktree_parse_failed',
      'worktree porcelain omitted its final record terminator',
    );
  }
  const finish = (): void => {
    if (current === null) {
      throw new GitEstateError('worktree_parse_failed', 'unexpected empty worktree record');
    }
    if (
      !current.path
      || (current.bare !== true && (
        current.head === undefined
        || (current.branch === undefined && current.detached !== true)
      ))
    ) {
      throw new GitEstateError('worktree_parse_failed', 'incomplete worktree record');
    }
    records.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      locked: current.locked ?? false,
      lockReason: current.lockReason ?? null,
      prunable: current.prunable ?? false,
      pruneReason: current.pruneReason ?? null,
    });
    current = null;
    phase = 'identity';
  };

  const tokens = raw.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (index === tokens.length - 1) {
      if (token !== '' || current !== null) {
        throw new GitEstateError('worktree_parse_failed', 'invalid worktree record framing');
      }
      continue;
    }
    if (token === '') {
      finish();
      continue;
    }
    const space = token.indexOf(' ');
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? '' : token.slice(space + 1);
    if (current === null) {
      if (key !== 'worktree' || !value) {
        throw new GitEstateError(
          'worktree_parse_failed',
          'worktree must be the first attribute of every record',
        );
      }
      current = { path: value };
      phase = 'identity';
      continue;
    }
    switch (key) {
      case 'HEAD':
        if (phase !== 'identity' || current.head !== undefined || !isFullObjectId(value)) {
          throw new GitEstateError('worktree_parse_failed', 'invalid worktree HEAD identity');
        }
        current.head = value;
        phase = 'checkout';
        break;
      case 'branch':
        if (phase !== 'checkout' || !/^refs\/heads\/\S+$/.test(value)) {
          throw new GitEstateError('worktree_parse_failed', 'invalid worktree branch identity');
        }
        current.branch = value.slice('refs/heads/'.length);
        phase = 'annotations';
        break;
      case 'detached':
        if (phase !== 'checkout' || value) {
          throw new GitEstateError('worktree_parse_failed', 'invalid detached worktree marker');
        }
        current.detached = true;
        phase = 'annotations';
        break;
      case 'locked':
        if (
          phase !== 'annotations'
          || current.bare === true
          || current.locked === true
          || current.prunable === true
        ) {
          throw new GitEstateError('worktree_parse_failed', 'invalid locked worktree marker');
        }
        current.locked = true;
        current.lockReason = value || null;
        break;
      case 'prunable':
        if (
          phase !== 'annotations'
          || current.bare === true
          || current.locked === true
          || current.prunable === true
          || !value
        ) {
          throw new GitEstateError('worktree_parse_failed', 'invalid prunable worktree marker');
        }
        current.prunable = true;
        current.pruneReason = value;
        break;
      case 'bare':
        if (phase !== 'identity' || value) {
          throw new GitEstateError('worktree_parse_failed', 'invalid bare worktree marker');
        }
        current.bare = true;
        phase = 'annotations';
        break;
      default:
        throw new GitEstateError('worktree_parse_failed', `unknown worktree field: ${key}`);
    }
  }
  if (records.length === 0) {
    throw new GitEstateError('worktree_parse_failed', 'git returned no worktree records');
  }
  return records;
}

export function parseStatus(raw: string): WorktreeStatus {
  if (!raw.endsWith('\0')) {
    throw new GitEstateError(
      'status_parse_failed',
      'porcelain-v2 status omitted its final NUL terminator',
    );
  }
  const tokens = raw.slice(0, -1).split('\0');
  if (tokens.some((token) => token.length === 0)) {
    throw new GitEstateError(
      'status_parse_failed',
      'porcelain-v2 status contained an empty record',
    );
  }
  const status: WorktreeStatus = {
    branchOid: null,
    branchHead: null,
    branchUpstream: null,
    ahead: 0,
    behind: 0,
    tracked: [],
    untracked: [],
    conflicts: [],
    conflictOperationMarker: null,
    conflictOperationReliable: false,
  };
  let branchOidSeen = false;
  let branchHeadSeen = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith('# ')) {
      const body = token.slice(2);
      const space = body.indexOf(' ');
      const key = space < 0 ? body : body.slice(0, space);
      const value = space < 0 ? '' : body.slice(space + 1);
      if (key === 'branch.oid') {
        if (branchOidSeen || (value !== '(initial)' && !isFullObjectId(value))) {
          throw new GitEstateError('status_parse_failed', 'invalid branch.oid header');
        }
        branchOidSeen = true;
        status.branchOid = value === '(initial)' ? null : value;
      } else if (key === 'branch.head') {
        if (branchHeadSeen || !value) {
          throw new GitEstateError('status_parse_failed', 'invalid branch.head header');
        }
        branchHeadSeen = true;
        status.branchHead = value === '(detached)' ? null : value;
      }
      else if (key === 'branch.upstream') status.branchUpstream = value || null;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (!match) throw new GitEstateError('status_parse_failed', 'invalid branch.ab header');
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      continue;
    }

    if (!branchOidSeen || !branchHeadSeen) {
      throw new GitEstateError(
        'status_parse_failed',
        'porcelain-v2 status record preceded mandatory branch identity headers',
      );
    }
    const kind = token[0];
    if (kind === '?') {
      const untrackedPath = token.startsWith('? ') ? token.slice(2) : '';
      if (!untrackedPath) {
        throw new GitEstateError('status_parse_failed', 'invalid untracked status record');
      }
      status.untracked.push(untrackedPath);
      continue;
    }
    if (kind === '!') {
      if (!token.startsWith('! ') || !token.slice(2)) {
        throw new GitEstateError('status_parse_failed', 'invalid ignored status record');
      }
      continue;
    }
    if (kind === '1') {
      const record = splitFixedStatusFields(token, 8);
      if (
        !record
        || record.fields[0] !== '1'
        || !isValidTrackedStatusFields(record.fields, ORDINARY_XY)
      ) {
        throw new GitEstateError('status_parse_failed', 'invalid ordinary status record');
      }
      const xy = record.fields[1]!;
      status.tracked.push({
        xy,
        path: record.remainder,
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
      });
      continue;
    }
    if (kind === '2') {
      const record = splitFixedStatusFields(token, 9);
      const originalPath = tokens[index + 1] ?? '';
      if (
        !record
        || record.fields[0] !== '2'
        || !isValidTrackedStatusFields(record.fields, RENAME_XY)
        || !isValidRenameScore(record.fields[1]!, record.fields[8]!)
        || !originalPath
      ) {
        throw new GitEstateError('status_parse_failed', 'invalid rename/copy status record');
      }
      index += 1;
      const xy = record.fields[1]!;
      status.tracked.push({
        xy,
        path: record.remainder,
        originalPath,
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
      });
      continue;
    }
    if (kind === 'u') {
      const record = splitFixedStatusFields(token, 10);
      const stageOids = record?.fields.slice(7, 10) ?? [];
      if (
        !record
        || record.fields[0] !== 'u'
        || !UNMERGED_XY_PATTERN.test(record.fields[1]!)
        || !SUBMODULE_STATE_PATTERN.test(record.fields[2]!)
        || !record.fields.slice(3, 7).every((mode) => FILE_MODE_PATTERN.test(mode))
        || stageOids.length !== 3
        || !stageOids.every(isFullObjectId)
      ) {
        throw new GitEstateError('status_parse_failed', 'invalid unmerged stage identities');
      }
      const xy = record.fields[1]!;
      status.conflicts.push({
        xy,
        path: record.remainder,
        stageOids: stageOids as [string, string, string],
      });
      continue;
    }
    throw new GitEstateError('status_parse_failed', `unknown porcelain status record: ${kind}`);
  }
  if (!branchOidSeen || !branchHeadSeen) {
    throw new GitEstateError(
      'status_parse_failed',
      'porcelain-v2 status omitted mandatory branch.oid or branch.head headers',
    );
  }
  status.tracked.sort((a, b) => compareText(a.path, b.path) || compareText(a.xy, b.xy));
  status.untracked.sort(compareText);
  status.conflicts.sort((a, b) => compareText(a.path, b.path) || compareText(a.xy, b.xy));
  return status;
}

function isValidTrackedStatusFields(
  fields: string[],
  allowedXy: ReadonlySet<string>,
): boolean {
  return (
    allowedXy.has(fields[1]!)
    && SUBMODULE_STATE_PATTERN.test(fields[2]!)
    && fields.slice(3, 6).every((mode) => FILE_MODE_PATTERN.test(mode))
    && fields.slice(6, 8).every(isFullObjectId)
  );
}

function isValidRenameScore(xy: string, score: string): boolean {
  const match = RENAME_SCORE_PATTERN.exec(score);
  return match !== null && xy.includes(match[1]!);
}

function splitFixedStatusFields(
  token: string,
  fixedFieldCount: number,
): { fields: string[]; remainder: string } | null {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 0; index < fixedFieldCount; index += 1) {
    const separator = token.indexOf(' ', cursor);
    if (separator < 0) return null;
    const field = token.slice(cursor, separator);
    if (!field) return null;
    fields.push(field);
    cursor = separator + 1;
  }
  const remainder = token.slice(cursor);
  return remainder ? { fields, remainder } : null;
}

export function parseBranches(raw: string): EstateBranch[] {
  const branches: EstateBranch[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [name = '', oid = '', upstreamValue = '', trackValue = '', scopeName = ''] = line.split('\0');
    if (!name || !isFullObjectId(oid)) {
      throw new GitEstateError('branch_parse_failed', 'invalid local branch record');
    }
    const track = trackValue.trim();
    const gone = track === 'gone';
    const ahead = Number(/\bahead (\d+)\b/.exec(track)?.[1] ?? 0);
    const behind = Number(/\bbehind (\d+)\b/.exec(track)?.[1] ?? 0);
    branches.push({
      name,
      scopeName: scopeName || name,
      oid,
      upstream: upstreamValue || null,
      ahead,
      behind,
      gone,
    });
  }
  return branches.sort((a, b) => compareText(a.name, b.name));
}

export function isValidBranchName(name: string): boolean {
  return name.length > 0
    && name !== '@'
    && !/[\s\x00-\x1f\x7f:~^?*\[\\]/.test(name)
    && !name.includes('..')
    && !name.includes('@{')
    && !name.startsWith('-')
    && !name.endsWith('.')
    && name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

export function parseStashes(raw: string): EstateStash[] {
  const stashes: EstateStash[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [oid = '', parentsValue = '', subject = ''] = line.split('\0');
    if (!isFullObjectId(oid)) {
      throw new GitEstateError('stash_parse_failed', 'invalid stash object identity');
    }
    const parents = parentsValue.split(' ').filter(Boolean).sort(compareText);
    if (!parents.every(isFullObjectId)) {
      throw new GitEstateError('stash_parse_failed', 'invalid stash parent identity');
    }
    const branch = /^(?:WIP on|On) (.+?): /.exec(subject)?.[1];
    stashes.push({ oid, parents, branch: branch && isValidBranchName(branch) ? branch : null });
  }
  stashes.sort((a, b) => compareText(a.oid, b.oid));
  return stashes;
}
