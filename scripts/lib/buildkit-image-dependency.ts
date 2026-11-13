const IMAGE_REFERENCE_PATTERN = /^(?<name>[a-z0-9][a-z0-9._/-]*):(?<tag>[A-Za-z0-9][A-Za-z0-9_.-]*)@(?<digest>sha256:[a-f0-9]{64})$/;

function parseImageReference(image: string): { name: string; tag: string; digest: string } {
  const match = IMAGE_REFERENCE_PATTERN.exec(image);
  if (!match?.groups?.name || !match.groups.tag || !match.groups.digest) {
    throw new Error('image reference must include a tag and immutable SHA-256 digest');
  }
  return {
    name: match.groups.name,
    tag: match.groups.tag,
    digest: match.groups.digest,
  };
}

export function buildkitImageDigest(image: string): string {
  return parseImageReference(image).digest;
}

export function buildkitImageDependency(image: string, platform: string): string {
  const { name, tag, digest } = parseImageReference(image);
  if (platform !== 'linux/amd64') throw new Error('unsupported container platform');
  return `pkg:docker/${name}@${tag}?digest=${digest}&platform=linux%2Famd64`;
}

export function isBuildkitImageDependency(
  dependency: unknown,
  image: unknown,
  platform: unknown,
): boolean {
  if (typeof dependency !== 'string' || typeof image !== 'string' || typeof platform !== 'string') return false;
  try {
    return dependency === buildkitImageDependency(image, platform);
  } catch {
    return false;
  }
}
