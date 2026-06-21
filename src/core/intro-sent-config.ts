import { mutatePrivateConfigFileSync } from './private-config-file.ts';

export function persistIntroSentFlag(configPath: string, introSent: boolean): void {
  mutatePrivateConfigFileSync(configPath, (raw) => {
    raw.introSent = introSent;
  });
}
