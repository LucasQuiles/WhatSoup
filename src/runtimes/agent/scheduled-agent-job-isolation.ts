const SCHEDULED_AGENT_JOB_SCOPE_SUFFIX = '::scheduled-agent-job';

export function resolveAgentTurnMapKey(baseMapKey: string, isSyntheticJob: boolean): string {
  return isSyntheticJob ? `${baseMapKey}${SCHEDULED_AGENT_JOB_SCOPE_SUFFIX}` : baseMapKey;
}

export function isScheduledAgentJobMapKey(mapKey: string): boolean {
  return mapKey.endsWith(SCHEDULED_AGENT_JOB_SCOPE_SUFFIX);
}

export function isolateScheduledAgentJobPrompt(prompt: string): string {
  return [
    '[isolated scheduled background turn]',
    'This is not a live user message. Do the scheduled work silently.',
    'Never expose reasoning, tool progress, commands, paths, provider/protocol details, receipts, exit codes, or session logs.',
    'If and only if there is one useful, verified user-facing update, deliver it with send_message to this turn\'s originating chat.',
    'Do not place the user-facing update in plain assistant text. When finished, output only NO_REPLY.',
    '',
    prompt,
  ].join('\n');
}
