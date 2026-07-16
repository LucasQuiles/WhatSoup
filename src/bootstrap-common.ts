export async function bootstrapCommon(
  targetModule: string,
  usageCommand: string,
  opts?: { authOnly?: boolean; databaseCompatibilityGate?: boolean },
): Promise<void> {
  const instanceName = process.argv[2];
  if (!instanceName) {
    throw new Error(`Usage: ${usageCommand} <instance-name>\nExample: ${usageCommand} loops`);
  }
  if (opts?.databaseCompatibilityGate) {
    const { configureDatabaseCompatibilityBootstrap } = await import(
      './database-compatibility-config.ts'
    );
    const { runEarlyDatabaseCompatibilityGate } = await import(
      './core/database-compatibility-early.ts'
    );
    configureDatabaseCompatibilityBootstrap(instanceName);
    if (await runEarlyDatabaseCompatibilityGate()) return;
  }
  const { loadInstance } = await import('./instance-loader.ts');
  const loadOptions = opts?.authOnly === undefined ? undefined : { authOnly: opts.authOnly };
  loadInstance(instanceName, loadOptions);
  await import(targetModule);
}
