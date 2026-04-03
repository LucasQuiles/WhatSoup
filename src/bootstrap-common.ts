import { loadInstance } from './instance-loader.ts';

export async function bootstrapCommon(targetModule: string, usageCommand: string, opts?: { authOnly?: boolean }): Promise<void> {
  const instanceName = process.argv[2];
  if (!instanceName) {
    throw new Error(`Usage: ${usageCommand} <instance-name>\nExample: ${usageCommand} loops`);
  }
  loadInstance(instanceName, opts);
  await import(targetModule);
}
