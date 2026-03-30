import { loadInstance } from './instance-loader.ts';

export async function bootstrap(): Promise<void> {
  const instanceName = process.argv[2];
  if (!instanceName) {
    throw new Error('Usage: whatsoup <instance-name>\nExample: whatsoup loops');
  }
  loadInstance(instanceName);
  await import('./main.ts');
}

// Auto-execute when run directly
const isDirectRun = process.argv[1]?.endsWith('bootstrap.ts');
if (isDirectRun) {
  bootstrap().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
