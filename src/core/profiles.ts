import type { LinkPreviewMode } from './send-pipeline.ts';

export interface Profile {
  prefix?: string;
  tag?: string;
  linkPreview?: LinkPreviewMode;
}

export type ProfileRegistry = ReadonlyMap<string, Profile>;
export type ProfileSeeds = Record<string, Profile>;

export class UnknownProfileError extends Error {
  constructor(profileName: string) {
    super(`unknown profile: ${profileName}`);
    this.name = 'UnknownProfileError';
  }
}

export function applyProfile(text: string, profile: Profile): string {
  return `${profile.prefix ?? ''}${text}${profile.tag ?? ''}`;
}

export function createProfileRegistry(profiles: ProfileSeeds): ProfileRegistry {
  return new Map(Object.entries(profiles));
}
