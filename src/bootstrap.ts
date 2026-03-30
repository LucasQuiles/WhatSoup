import { bootstrapCommon } from './bootstrap-common.ts';

export async function bootstrap(): Promise<void> {
  await bootstrapCommon('./main.ts', 'whatsoup');
}

// Auto-execute when run directly
const isDirectRun = process.argv[1]?.endsWith('bootstrap.ts');
if (isDirectRun) {
  bootstrap().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
