import { bootstrapCommon } from './bootstrap-common.ts';

export async function bootstrapAuth(): Promise<void> {
  await bootstrapCommon('./transport/auth.ts', 'whatsoup-auth', { authOnly: true });
}

const isDirectRun = process.argv[1]?.endsWith('bootstrap-auth.ts');
if (isDirectRun) {
  bootstrapAuth().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
