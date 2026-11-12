import { describe, expect, it } from 'vitest';

import { uploadedFilePath } from './files';

const file = (name: string, relativePath = '') => {
  const value = new File(['x'], name);
  Object.defineProperty(value, 'webkitRelativePath', { value: relativePath });
  return value;
};

describe('uploadedFilePath', () => {
  it('places a file in the directory the upload targets', () => {
    expect(uploadedFilePath('', file('a.txt'))).toBe('a.txt');
    expect(uploadedFilePath('docs/specs', file('a.txt'))).toBe(
      'docs/specs/a.txt',
    );
  });

  it('keeps the structure of a folder upload below that directory', () => {
    expect(uploadedFilePath('', file('c.md', 'proj/sub/c.md'))).toBe(
      'proj/sub/c.md',
    );
    expect(uploadedFilePath('docs', file('c.md', 'proj/c.md'))).toBe(
      'docs/proj/c.md',
    );
  });
});
