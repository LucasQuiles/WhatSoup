import { createHash } from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import type { PineconeMemory } from '../runtimes/chat/providers/pinecone.ts';
import type { LLMProvider } from '../runtimes/chat/providers/types.ts';
import { clusterMemories, consolidateCluster } from './consolidation.ts';

const log = createChildLogger('consolidation-cron');

interface ConsolidationOptions {
  lookbackDays: number;
  dryRun: boolean;
}

interface ConsolidationReport {
  promoted: number;
  discarded: number;
  clustersProcessed: number;
  errors: number;
}

function shortHash(text: string, length: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

function scopeKey(chatJid: string, senderJid: string): string {
  return `${chatJid}\0${senderJid}`;
}

export async function runConsolidation(
  pinecone: Pick<PineconeMemory, 'search' | 'upsert'>,
  provider: LLMProvider,
  options: ConsolidationOptions,
): Promise<ConsolidationReport> {
  const report: ConsolidationReport = {
    promoted: 0,
    discarded: 0,
    clustersProcessed: 0,
    errors: 0,
  };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - options.lookbackDays);

  let recentMemories;
  try {
    recentMemories = await pinecone.search(
      'facts about people preferences locations interests',
      {},
      100,
    );
  } catch (err) {
    log.error({ err }, 'Failed to fetch recent memories');
    return { ...report, errors: 1 };
  }

  const cutoffMs = cutoffDate.getTime();
  recentMemories = recentMemories.filter((r) => {
    const createdMs = new Date(r.record.createdAt).getTime();
    return !isNaN(createdMs) && createdMs >= cutoffMs;
  });

  if (recentMemories.length === 0) {
    log.info('No recent memories to consolidate');
    return report;
  }

  const records = recentMemories.map((r) => ({
    id: r.id,
    text: r.record.text,
    claim: r.record.claim ?? '',
    evidence: r.record.evidence ?? '',
    createdAt: r.record.createdAt,
    confidence: r.record.confidence,
    chatJid: r.record.chatJid ?? '',
    senderJid: r.record.senderJid ?? '',
  }));

  const scopedRecords = new Map<string, {
    chatJid: string;
    senderJid: string;
    records: typeof records;
  }>();
  let unscopedSkipped = 0;
  for (const record of records) {
    if (!record.chatJid || !record.senderJid) {
      unscopedSkipped += 1;
      continue;
    }
    const key = scopeKey(record.chatJid, record.senderJid);
    const group = scopedRecords.get(key) ?? {
      chatJid: record.chatJid,
      senderJid: record.senderJid,
      records: [],
    };
    group.records.push(record);
    scopedRecords.set(key, group);
  }

  if (scopedRecords.size === 0) {
    log.info({ recordCount: records.length, unscopedSkipped }, 'No scoped memories to consolidate');
    return report;
  }

  for (const group of scopedRecords.values()) {
    const clusters = clusterMemories(group.records);
    log.info({
      clusterCount: clusters.length,
      recordCount: group.records.length,
      unscopedSkipped,
    }, 'Clustered memories');

    for (const cluster of clusters) {
      report.clustersProcessed += 1;

      try {
        const result = await consolidateCluster(provider, cluster);
        report.discarded += result.discarded.length;

        if (result.durableKnowledge.length === 0) continue;

        if (options.dryRun) {
          report.promoted += result.durableKnowledge.length;
          log.info({
            dryRun: true,
            claimHashes: result.durableKnowledge.map((d) => shortHash(d.claim, 12)),
            durableCount: result.durableKnowledge.length,
          }, 'Would promote');
          continue;
        }

        for (const durable of result.durableKnowledge) {
          const now = new Date().toISOString();
          await pinecone.upsert([{
            id: `durable:${shortHash(scopeKey(group.chatJid, group.senderJid) + `\0${durable.claim}`, 16)}`,
            text: durable.claim,
            chatJid: group.chatJid,
            senderJid: group.senderJid,
            senderName: '',
            memoryType: 'user_fact',
            confidence: Math.max(0, Math.min(1, durable.confidence)),
            createdAt: now,
            updatedAt: now,
            superseded: '',
            sourceMessagePks: '',
            promotionReason: durable.promotionReason,
            claim: durable.claim,
            evidence: durable.sourceRecordIds.join(', '),
            warrant: durable.promotionReason,
            confidenceQualifier: 'consolidated',
            contradicts: '',
          }]);
          report.promoted += 1;
        }
      } catch (err) {
        log.warn({ err, recordCount: cluster.records.length }, 'Cluster consolidation failed');
        report.errors += 1;
      }
    }
  }

  log.info(report, 'Consolidation run complete');
  return report;
}
