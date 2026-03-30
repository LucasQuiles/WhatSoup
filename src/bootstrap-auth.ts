import { loadInstance } from './instance-loader.ts';

export async function bootstrapAuth(): Promise<void> {
  const instanceName = process.argv[2];
  if (!instanceName) {
    throw new Error('Usage: whatsoup-auth <instance-name>\nExample: whatsoup-auth personal');
  }
  loadInstance(instanceName);
  await import('./transport/auth.ts');
}

const isDirectRun = process.argv[1]?.endsWith('bootstrap-auth.ts');
if (isDirectRun) {
  bootstrapAuth().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
