import fs from 'fs';

/**
 * What stat can tell about a file's contents. Atomic rewrites (tmp + rename)
 * change `ino`; in-place rewrites change mtime/ctime and usually size.
 */
export interface FileSignature {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export function statFileSignature(filePath: string): FileSignature | null {
  try {
    const st = fs.statSync(filePath);
    return {
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
    };
  } catch {
    return null;
  }
}

export function sameFileSignature(
  a: FileSignature | null,
  b: FileSignature | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

/**
 * File timestamps are coarse (a kernel tick, or a whole second on some
 * filesystems), so a same-size in-place rewrite right after the observed one
 * can keep its signature. As with git's "racily clean" index entries, a
 * signature only proves the contents unchanged once it was observed at least
 * this long after the file's mtime; until then readers re-read the file.
 */
const RACY_SIGNATURE_WINDOW_MS = 2_000;

export function fileSignatureSettled(
  sig: FileSignature | null,
  observedAt: number,
): boolean {
  return sig === null || observedAt - sig.mtimeMs >= RACY_SIGNATURE_WINDOW_MS;
}
