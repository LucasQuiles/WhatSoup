import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { coveragePlanDigest, parseCoveragePlan, readCoverageArtifact } from './coverage-shards.ts';

export default class CoverageShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const path = process.env.WHATSOUP_COVERAGE_PLAN;
    if (!path) throw new Error('Coverage shard plan is required');
    const plan = parseCoveragePlan(JSON.parse(readCoverageArtifact(path, undefined, 8 * 1024 * 1024).toString('utf8')));
    if (coveragePlanDigest(plan) !== process.env.WHATSOUP_COVERAGE_PLAN_DIGEST) {
      throw new Error('Coverage shard plan changed after admission');
    }
    const shard = this.ctx.config.shard;
    if (!shard || shard.count !== 2 || this.ctx.config.root !== plan.identity.root) {
      throw new Error('Coverage shard configuration does not match its plan');
    }
    const names = files.map((file) => relative(plan.identity.root, file.moduleId));
    if (JSON.stringify([...names].sort()) !== JSON.stringify(plan.shards.flat().sort())) {
      throw new Error('Native coverage test inventory changed after planning');
    }
    const selected = new Set(plan.shards[shard.index - 1]);
    return files.filter((_, index) => selected.has(names[index]!));
  }
}
