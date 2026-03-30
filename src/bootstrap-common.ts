import { loadInstance } from './instance-loader.ts';

export async function bootstrapCommon(targetModule: string, usageCommand: string): Promise<void> {
  const instanceName = process.argv[2];
  if (!instanceName) {
    throw new Error(`Usage: ${usageCommand} <instance-name>\nExample: ${usageCommand} loops`);
  }
  loadInstance(instanceName);
  await import(targetModule);
}
