import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectNodePinReadings,
  findNodePinDrift,
  run,
} from '../../scripts/check-node-pin-consistency.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const TEST_DOCKER_DIGEST = '4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d';
const TEST_SNAPSHOT = '20261001T000000Z';

/**
 * Build a minimal repo fixture with the four pin surfaces (nvmrc, package.json,
 * Dockerfile, three wrappers). Each surface defaults to the canonical version
 * unless an override is provided.
 */
function makeFixture(opts: {
  nvmrc?: string;
  voltaNode?: string;
  enginesNode?: string;
  dockerVersion?: string;
  dockerDigest?: string | null;
  aptSnapshot?: string;
  aptSource?: 'approved' | 'https-snapshot' | 'mutable' | 'unavailable';
  wrapperVersion?: string | 'reads-nvmrc' | 'none';
  wrappers?: (
    | 'deploy/whatsoup'
    | 'deploy/whatsoup-auth'
    | 'deploy/whatsoup-fleet'
    | 'scripts/run-with-pinned-node.sh'
    | 'scripts/run-with-pinned-npm.sh'
    | 'deploy/templates/watchdog-script.sh'
  )[];
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whatsoup-node-pin-'));
  const nvmrc = opts.nvmrc ?? '24.15.0';
  const voltaNode = opts.voltaNode ?? '24.15.0';
  const enginesNode = opts.enginesNode ?? '>=24.0.0 <26';
  const dockerVersion = opts.dockerVersion ?? '24.15.0';
  const dockerDigest = opts.dockerDigest === undefined
    ? TEST_DOCKER_DIGEST
    : opts.dockerDigest;
  const aptSnapshot = opts.aptSnapshot ?? TEST_SNAPSHOT;
  const aptSource = opts.aptSource ?? 'approved';
  const wrapperVersion = opts.wrapperVersion ?? 'reads-nvmrc';
  const wrappers = opts.wrappers ?? [
    'deploy/whatsoup',
    'deploy/whatsoup-auth',
    'deploy/whatsoup-fleet',
    'scripts/run-with-pinned-node.sh',
    'scripts/run-with-pinned-npm.sh',
    'deploy/templates/watchdog-script.sh',
  ];

  writeFileSync(path.join(dir, '.nvmrc'), `${nvmrc}\n`, 'utf8');
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        engines: { node: enginesNode },
        volta: { node: voltaNode },
      },
      null,
      2,
    ),
    'utf8',
  );

  mkdirSync(path.join(dir, 'docker'), { recursive: true });
  const approvedDebianSource = `http://snapshot.debian.org/archive/debian/${aptSnapshot}/`;
  const approvedDebianSecuritySource = `http://snapshot.debian.org/archive/debian-security/${aptSnapshot}/`;
  const sourceUrl = aptSource === 'mutable'
    ? 'http://deb.debian.org/debian/'
    : aptSource === 'unavailable'
      ? `https://snapshot.debian.org/archive/debian/${aptSnapshot}/`
      : aptSource === 'https-snapshot'
        ? `https://snapshot.debian.org/archive/debian/${aptSnapshot}/`
      : approvedDebianSource;
  const securitySourceUrl = aptSource === 'approved'
    ? approvedDebianSecuritySource
    : aptSource === 'https-snapshot'
      ? `https://snapshot.debian.org/archive/debian-security/${aptSnapshot}/`
      : sourceUrl;
  writeFileSync(
    path.join(dir, 'docker/Dockerfile'),
    [
      `FROM node:${dockerVersion}-slim${dockerDigest === null ? '' : `@sha256:${dockerDigest}`} AS base`,
      'RUN printf \'%s\\n\' \\',
      `  'deb [check-valid-until=no] ${sourceUrl} bookworm main' \\`,
      `  'deb [check-valid-until=no] ${securitySourceUrl} bookworm-security main' \\`,
      '  > /etc/apt/sources.list \\',
      '  && rm -rf /etc/apt/sources.list.d/*',
      'FROM base AS deps',
      'RUN apt-get -o APT::Update::Error-Mode=any update',
      'FROM base AS runtime',
      'RUN apt-get -o APT::Update::Error-Mode=any update',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'docker/container-inputs.json'),
    `${JSON.stringify({
      schemaVersion: 3,
      platform: 'linux/amd64',
      sourceRepository: 'https://github.com/LucasQuiles/WhatSoup.git',
      baseImage: `node:24.15.0-slim@sha256:${TEST_DOCKER_DIGEST}`,
      baseImageDependency: 'pkg:docker/node@24.15.0-slim?digest=sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d&platform=linux%2Famd64',
      baseImageResolvedDigest: `sha256:${'d'.repeat(64)}`,
      builder: {
        name: 'whatsoup-ci-builder',
        driver: 'docker-container',
        provenanceIdPrefix: 'https://github.com/LucasQuiles/WhatSoup/actions/runs/',
      },
      buildx: {
        version: 'v0.38.0',
        asset: 'buildx-v0.38.0.linux-amd64',
        sha256: `sha256:${'c'.repeat(64)}`,
        buildkitImage: `moby/buildkit:v0.33.1@sha256:${'b'.repeat(64)}`,
      },
      sbom: {
        generator: 'docker/buildkit-syft-scanner:stable-1@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9',
        dependency: 'pkg:docker/docker/buildkit-syft-scanner@stable-1?digest=sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9&platform=linux%2Famd64',
        resolvedDigest: `sha256:${'f'.repeat(64)}`,
      },
      apt: {
        snapshot: aptSnapshot,
        sources: [
          `${approvedDebianSource} bookworm main`,
          `${approvedDebianSecuritySource} bookworm-security main`,
        ],
      },
    }, null, 2)}\n`,
    'utf8',
  );

  for (const wrapperPath of wrappers) {
    mkdirSync(path.dirname(path.join(dir, wrapperPath)), { recursive: true });
    let body = '#!/usr/bin/env bash\nset -euo pipefail\n';
    if (wrapperVersion === 'reads-nvmrc') {
      body += 'REPO_ROOT="$(pwd)"\nNODE_VERSION="$(cat "$REPO_ROOT/.nvmrc")"\n';
    } else if (wrapperVersion === 'none') {
      body += 'NODE="$(command -v node)"\n';
    } else {
      body += `DEFAULT_NODE="$HOME/.nvm/versions/node/v${wrapperVersion}/bin/node"\n`;
    }
    writeFileSync(path.join(dir, wrapperPath), body, 'utf8');
  }
  return dir;
}

describe('node-pin consistency check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('passes on the real repo with all surfaces aligned', () => {
    const drift = findNodePinDrift({ cwd: repoRoot });
    expect(drift.canonical).toMatch(/^\d+\.\d+\.\d+$/);
    expect(drift.mismatches).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it('scans the watchdog template and reads its hardcoded node-path pin (#F6)', () => {
    // The watchdog template hardcodes __HOME__/.nvm/.../v<version>/bin/node and
    // never reads .nvmrc; the guard must extract that version so a bump fails CI.
    const readings = collectNodePinReadings({ cwd: repoRoot });
    const watchdog = readings.find(
      (r) => r.source === 'deploy/templates/watchdog-script.sh',
    );
    expect(watchdog).toBeDefined();
    expect(watchdog?.version).toMatch(/^\d+\.\d+\.\d+$/);
    const canonical = readings.find((r) => r.source === '.nvmrc')?.version;
    expect(watchdog?.version).toBe(canonical);
  });

  it('pins the package manager to a concrete npm version (supply-chain drift guard)', () => {
    // #1111: packageManager must be present and pin npm (not yarn/pnpm) to a
    // concrete version — the npm bundled with the volta-pinned Node, so no
    // Corepack network fetch is required. Guards against removal, typos, or an
    // accidental package-manager swap.
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { packageManager?: string };
    expect(pkg.packageManager).toBeDefined();
    expect(pkg.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/);
  });

  it('passes on a happy-path fixture where wrappers read .nvmrc', () => {
    const dir = makeFixture({});
    const drift = findNodePinDrift({ cwd: dir });
    expect(drift.canonical).toBe('24.15.0');
    expect(drift.mismatches).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it('flags wrappers that hardcode a stale Node version path', () => {
    const dir = makeFixture({ wrapperVersion: '24.13.0' });
    const drift = findNodePinDrift({ cwd: dir });
    expect(drift.canonical).toBe('24.15.0');
    expect(drift.mismatches).toHaveLength(6);
    for (const m of drift.mismatches) {
      expect(m.version).toBe('24.13.0');
      expect([
        'deploy/whatsoup',
        'deploy/whatsoup-auth',
        'deploy/whatsoup-fleet',
        'scripts/run-with-pinned-node.sh',
        'scripts/run-with-pinned-npm.sh',
        'deploy/templates/watchdog-script.sh',
      ]).toContain(m.source);
    }
  });

  it('flags a Dockerfile pinned to a non-canonical version', () => {
    const dir = makeFixture({ dockerVersion: '24.14.0' });
    const drift = findNodePinDrift({ cwd: dir });
    const dockerMismatches = drift.mismatches.filter(
      (m) => m.source === 'docker/Dockerfile',
    );
    expect(dockerMismatches.length).toBeGreaterThan(0);
    for (const m of dockerMismatches) {
      expect(m.version).toBe('24.14.0');
    }
  });

  it('rejects a Dockerfile base that omits an immutable image digest', () => {
    const dir = makeFixture({ dockerDigest: null });

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: path.join(dir, 'docker/Dockerfile'),
      reason: 'base image is not pinned by digest',
    });
  });

  it('rejects a base digest changed from the reviewed container-input policy', () => {
    const dir = makeFixture({ dockerDigest: 'b'.repeat(64) });

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: path.join(dir, 'docker/Dockerfile'),
      reason: 'base image does not match docker/container-inputs.json',
    });
  });

  it('requires reviewed Buildx and BuildKit identities in the container input policy', () => {
    const dir = makeFixture({});
    const policyPath = path.join(dir, 'docker/container-inputs.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
    policy.buildx = { version: 'latest', buildkitImage: 'moby/buildkit:latest' };
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, 'utf8');

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/container-inputs.json',
      filePath: policyPath,
      reason: 'invalid container input policy shape',
    });
  });

  it('requires provenance dependency PURLs to bind the immutable input digest', () => {
    const dir = makeFixture({});
    const policyPath = path.join(dir, 'docker/container-inputs.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
    policy.baseImageDependency = 'pkg:docker/node@24.15.0-slim?platform=linux%2Famd64';
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, 'utf8');

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/container-inputs.json',
      filePath: policyPath,
      reason: 'invalid container input policy shape',
    });
  });

  it('rejects a policy that omits the immutable SBOM generator identity', () => {
    const dir = makeFixture({});
    const policyPath = path.join(dir, 'docker/container-inputs.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
    delete policy.sbom;
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, 'utf8');

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/container-inputs.json',
      filePath: policyPath,
      reason: 'invalid container input policy shape',
    });
  });

  it('rejects mutable package sources outside the approved snapshot policy', () => {
    const dir = makeFixture({ aptSource: 'mutable' });

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: path.join(dir, 'docker/Dockerfile'),
      reason: 'APT source definitions must exactly match docker/container-inputs.json',
    });
  });

  it('rejects HTTPS snapshot sources that cannot bootstrap before ca-certificates is installed', () => {
    const dir = makeFixture({ aptSource: 'https-snapshot' });
    const policyPath = path.join(dir, 'docker/container-inputs.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
      apt: { sources: string[] };
    };
    policy.apt.sources = policy.apt.sources.map((source) => source.replace('http://', 'https://'));
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, 'utf8');

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/container-inputs.json',
      filePath: policyPath,
      reason: 'APT sources must use the CA-independent approved Debian snapshot transport',
    });
  });

  it.each([
    'RUN apt-get update --allow-insecure-repositories',
    'RUN apt-get update --allow-weak-repositories',
    'RUN apt-get install --allow-unauthenticated tini',
    'RUN apt-get -o Acquire::AllowInsecureRepositories=true update',
    'RUN apt-get -o Acquire::AllowWeakRepositories=true update',
    'RUN apt-get -o Acquire::AllowDowngradeToInsecureRepositories=1 update',
    'RUN apt-get -o APT::Get::AllowUnauthenticated=true install tini',
    `RUN printf '%s\\n' 'Acquire::AllowInsecureRepositories "true";' > /tmp/apt.conf \\
    && apt-get -c /tmp/apt.conf -o APT::Update::Error-Mode=any update`,
    `RUN printf '%s\\n' 'Acquire::AllowWeakRepositories "yes";' > /tmp/apt.conf \\
    && apt-get -c /tmp/apt.conf -o APT::Update::Error-Mode=any update`,
    `RUN printf '%s\\n' 'Acquire::AllowDowngradeToInsecureRepositories "1";' > /tmp/apt.conf \\
    && apt-get -c /tmp/apt.conf -o APT::Update::Error-Mode=any update`,
    `RUN printf '%s\\n' 'APT::Get::AllowUnauthenticated "true";' > /tmp/apt.conf \\
    && apt-get -c /tmp/apt.conf install tini`,
    "RUN printf '%s\\n' 'deb [allow-weak=yes] http://example.invalid/debian bookworm main' > /tmp/source.list",
  ])('rejects APT authentication bypasses: %s', (unsafeInstruction) => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}${unsafeInstruction}\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not disable APT repository authentication',
    });
  });

  it('requires every APT index refresh to fail on any unavailable snapshot source', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      readFileSync(dockerfilePath, 'utf8').replace(
        'apt-get -o APT::Update::Error-Mode=any update',
        'apt-get update',
      ),
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'every apt-get update must fail on any unavailable snapshot source',
    });
  });

  it('rejects an additive mutable source even when the approved source lines remain', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}RUN printf '%s\\n' 'deb https://deb.debian.org/debian bookworm main' >> /etc/apt/sources.list\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'APT source definitions must exactly match docker/container-inputs.json',
    });
  });

  it('rejects approved source text that appears only in comments', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(dockerfilePath, [
      `FROM node:24.15.0-slim@sha256:${TEST_DOCKER_DIGEST} AS base`,
      `# deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${TEST_SNAPSHOT}/ bookworm main`,
      `# deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${TEST_SNAPSHOT}/ bookworm-security main`,
      'RUN : > /etc/apt/sources.list && rm -rf /etc/apt/sources.list.d/*',
      'FROM base AS deps',
      'FROM base AS runtime',
      '',
    ].join('\n'), 'utf8');

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'APT source definitions must exactly match docker/container-inputs.json',
    });
  });

  it('rejects approved source text in a continued shell comment', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(dockerfilePath, [
      `FROM node:24.15.0-slim@sha256:${TEST_DOCKER_DIGEST} AS base`,
      'RUN \\',
      `  # deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${TEST_SNAPSHOT}/ bookworm main \\`,
      `  # deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${TEST_SNAPSHOT}/ bookworm-security main \\`,
      '  : > /etc/apt/sources.list && rm -rf /etc/apt/sources.list.d/*',
      'FROM base AS deps',
      'FROM base AS runtime',
      '',
    ].join('\n'), 'utf8');

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'APT source definitions must exactly match docker/container-inputs.json',
    });
  });

  it('rejects approved source text in a non-RUN Dockerfile instruction', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(dockerfilePath, [
      `FROM node:24.15.0-slim@sha256:${TEST_DOCKER_DIGEST} AS base`,
      `LABEL source_one="deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${TEST_SNAPSHOT}/ bookworm main"`,
      `LABEL source_two="deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${TEST_SNAPSHOT}/ bookworm-security main"`,
      'RUN : > /etc/apt/sources.list && rm -rf /etc/apt/sources.list.d/*',
      'FROM base AS deps',
      'FROM base AS runtime',
      '',
    ].join('\n'), 'utf8');

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'APT source definitions must exactly match docker/container-inputs.json',
    });
  });

  it('rejects a source descriptor reintroduced after clearing inherited descriptors', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}RUN printf '%s\\n' 'deb https://deb.debian.org/debian bookworm main' > /etc/apt/sources.list.d/extra.list\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile does not fully clear inherited APT source descriptors',
    });
  });

  it('rejects a later COPY that replaces the approved APT source file', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}COPY replacement.list /etc/apt/sources.list\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    });
  });

  it('rejects a later shell copy that replaces the approved APT source file', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}RUN cp /tmp/replacement.list /etc/apt/sources.list\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    });
  });

  it('rejects a relative descriptor replacement after changing into /etc', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}RUN cd /etc && cp /tmp/replacement.list apt/sources.list\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    });
  });

  it('rejects a relative descriptor replacement from Dockerfile root', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}RUN cp /tmp/replacement.list etc/apt/sources.list\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    });
  });

  it('rejects a relative ADD destination that can replace an APT descriptor', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}ADD replacement.list etc/apt/sources.list\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    });
  });

  it('rejects a later ADD that can repopulate a cleared APT source directory', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}ADD replacement.list /etc/apt/sources.list.d/replacement.list\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    });
  });

  it('rejects a working directory that makes relative APT source replacement possible', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}WORKDIR /etc/apt\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    });
  });

  it('rejects environment and build-argument indirection to the APT descriptor root', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}ENV APT_ROOT /etc\nARG APT_FALLBACK=/etc\nRUN cp /tmp/replacement.list "$APT_ROOT/apt/sources.list" && cp /tmp/replacement.list "$APT_FALLBACK/apt/sources.list"\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not modify APT source descriptors outside the approved bootstrap',
    });
  });

  it('rejects a root-prefix build argument composed into an APT descriptor path', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}ARG ROOT=/\nRUN cp /tmp/replacement.list "\${ROOT}etc/apt/sources.list"\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not use variable or command expansion until the static invariant is extended',
    });
  });

  it('rejects split-token variables composed into an APT descriptor path', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}ARG ROOT=/\nARG ETC=etc\nARG APT=apt\nRUN cp /tmp/replacement.list "\${ROOT}\${ETC}/\${APT}/sources.list"\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not use variable or command expansion until the static invariant is extended',
    });
  });

  it('rejects backtick command substitution in an active Dockerfile instruction', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    writeFileSync(
      dockerfilePath,
      `${readFileSync(dockerfilePath, 'utf8')}RUN printf '%s\\n' \`unreviewed-command\` > /tmp/build-marker\n`,
      'utf8',
    );

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not use variable or command expansion until the static invariant is extended',
    });
  });

  it('rejects a variable-driven overwrite appended to the approved bootstrap', () => {
    const dir = makeFixture({});
    const dockerfilePath = path.join(dir, 'docker/Dockerfile');
    const dockerfile = readFileSync(dockerfilePath, 'utf8')
      .replace(
        "RUN printf '%s\\n' \\",
        'ARG ROOT=/\\nARG APT_TARGET="\\${ROOT}etc/apt/sources.list"\\nRUN printf \'%s\\n\' \\\\',
      )
      .replace(
        '&& rm -rf /etc/apt/sources.list.d/*',
        '&& rm -rf /etc/apt/sources.list.d/* && cp /tmp/replacement.list "$APT_TARGET"',
      );
    writeFileSync(dockerfilePath, dockerfile, 'utf8');

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/Dockerfile',
      filePath: dockerfilePath,
      reason: 'Dockerfile may not use variable or command expansion until the static invariant is extended',
    });
  });

  it('rejects a package snapshot whose immutable identifier is unavailable', () => {
    const dir = makeFixture({
      aptSnapshot: 'not-a-snapshot',
      aptSource: 'unavailable',
    });

    const drift = findNodePinDrift({ cwd: dir });

    expect(drift.missing).toContainEqual({
      source: 'docker/container-inputs.json',
      filePath: path.join(dir, 'docker/container-inputs.json'),
      reason: 'APT snapshot must be a UTC timestamp in YYYYMMDDTHHMMSSZ form',
    });
  });

  it('fails closed when requested snapshot release metadata cannot be retrieved', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = makeFixture({});
    const binDir = mkdtempSync(path.join(tmpdir(), 'whatsoup-curl-'));
    const curlPath = path.join(binDir, 'curl');
    writeFileSync(curlPath, '#!/bin/sh\nexit 22\n', 'utf8');
    chmodSync(curlPath, 0o755);

    run(['--verify-container-snapshot'], dir, { PATH: binDir });

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('APT snapshot release metadata is unavailable'),
    );
  });

  it('flags a volta.node pinned to a non-canonical version', () => {
    const dir = makeFixture({ voltaNode: '24.10.0' });
    const drift = findNodePinDrift({ cwd: dir });
    const voltaMismatch = drift.mismatches.find(
      (m) => m.source === 'package.json#volta.node',
    );
    expect(voltaMismatch).toBeDefined();
    expect(voltaMismatch?.version).toBe('24.10.0');
  });

  it('reports a missing volta.node as a structural problem, not a mismatch', () => {
    const dir = makeFixture({ voltaNode: '' });
    // Manually rewrite package.json to omit volta entirely.
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', engines: { node: '>=24.0.0 <26' } }, null, 2),
      'utf8',
    );
    const drift = findNodePinDrift({ cwd: dir });
    const voltaMissing = drift.missing.find(
      (m) => m.source === 'package.json#volta.node',
    );
    expect(voltaMissing).toEqual({
      source: 'package.json#volta.node',
      filePath: path.join(dir, 'package.json'),
      reason: 'volta.node not set',
    });
    // Mismatches list must not double-count a missing pin.
    expect(
      drift.mismatches.find((m) => m.source === 'package.json#volta.node'),
    ).toBeUndefined();
  });

  it('run() exits non-zero and prints diagnostics when drift is present', () => {
    const dir = makeFixture({ wrapperVersion: '24.13.0' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const drift = run([], dir, {});

    expect(process.exitCode).toBe(1);
    expect(drift.mismatches.length).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalled();
    const printed = errorSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('Canonical Node version');
    expect(printed).toContain('24.13.0');
  });

  it('run() honors the WHATSOUP_SKIP_NODE_PIN_CHECK escape hatch locally', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Point at a drift-laden fixture; the escape hatch must short-circuit
    // before any file reads happen, returning the empty-skip sentinel.
    const dir = makeFixture({ wrapperVersion: '24.13.0' });
    const drift = run([], dir, { WHATSOUP_SKIP_NODE_PIN_CHECK: '1' });
    expect(drift).toEqual({ canonical: '', mismatches: [], missing: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      'node-pin consistency check skipped via WHATSOUP_SKIP_NODE_PIN_CHECK=1',
    );
    // Skip path must not flip the CLI exit code from undefined to a failing value,
    // even though the underlying fixture is intentionally drift-laden.
    expect(process.exitCode).not.toBe(1);
    expect(process.exitCode).toBe(undefined);
  });

  it('run() ignores WHATSOUP_SKIP_NODE_PIN_CHECK in CI and still reports drift', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = makeFixture({ wrapperVersion: '24.13.0' });

    const drift = run([], dir, { WHATSOUP_SKIP_NODE_PIN_CHECK: '1', CI: 'true' });

    expect(drift.mismatches.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'WHATSOUP_SKIP_NODE_PIN_CHECK=1 ignored: CI/GITHUB_ACTIONS detected; node-pin consistency check will run (this skip is for local dev only)',
    );
  });

  it('run() ignores WHATSOUP_SKIP_NODE_PIN_CHECK in GitHub Actions and still reports drift', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = makeFixture({ wrapperVersion: '24.13.0' });

    const drift = run([], dir, { WHATSOUP_SKIP_NODE_PIN_CHECK: '1', GITHUB_ACTIONS: 'true' });

    expect(drift.mismatches.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'WHATSOUP_SKIP_NODE_PIN_CHECK=1 ignored: CI/GITHUB_ACTIONS detected; node-pin consistency check will run (this skip is for local dev only)',
    );
  });
});

describe('sub-package engines align with root (#1082)', () => {
  function enginesNode(rel: string): string | undefined {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8')) as { engines?: { node?: string } };
    return pkg.engines?.node;
  }

  it('console and whatsoup_guard declare the same engines.node as root', () => {
    const root = enginesNode('package.json');
    expect(root).toBeTruthy();
    expect(enginesNode('console/package.json')).toBe(root);
    expect(enginesNode('tools/whatsoup_guard/package.json')).toBe(root);
  });
});
