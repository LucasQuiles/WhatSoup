export function isBaileysEncryptedTmpEnoent(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false;
  const nodeErr = err as NodeJS.ErrnoException;
  return nodeErr.code === 'ENOENT' &&
    typeof nodeErr.path === 'string' &&
    /(?:^|[/\\])(?:document|image|audio|video|sticker)[^/\\]*-enc$/.test(nodeErr.path);
}
