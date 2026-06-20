import { bootstrapCommon } from './bootstrap-common.ts';
import { errorMessage } from './lib/error-message.ts';

export async function bootstrapAuth(): Promise<void> {
  await bootstrapCommon('./transport/auth.ts', 'whatsoup-auth', { authOnly: true });
}

const isDirectRun = process.argv[1]?.endsWith('bootstrap-auth.ts');
if (isDirectRun) {
  bootstrapAuth().catch((err) => {
    console.error(errorMessage(err));
    process.exit(1);
  });
}
