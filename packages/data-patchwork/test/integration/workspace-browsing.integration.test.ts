import { expect, test } from 'vitest';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { type FileDoc } from '../../src/index.js';
import { fixture } from '../fixture.js';
import path from 'node:path';

test('browses empty directories and rejects traversal and directory symlinks outside the opened folder', async () => {
  const { directory, root, workspace } = await fixture();
  await workspace.mkdir('empty');
  await symlink(directory, path.join(root, 'outside'));
  expect((await workspace.browse('.')).map((entry) => entry.name)).toEqual(['empty', 'note.md']);
  expect(await workspace.browse('empty')).toEqual([]);
  await expect(workspace.browse('..')).rejects.toThrow('inside');
  await expect(workspace.browse('outside')).rejects.toThrow('outside');
  await expect(workspace.mkdir('../escape')).rejects.toThrow('inside');
  await expect(workspace.mkdir('outside/escape')).rejects.toThrow('outside');
  await expect(workspace.mkdir('empty')).rejects.toMatchObject({ code: 'EEXIST' });
});

test('resolves local images relative to notes and confines symlinks to the workspace', async () => {
  const { directory, root, workspace } = await fixture();
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'pixel image.svg'), '<svg/>');
  await writeFile(path.join(directory, 'outside.svg'), '<svg/>');
  await symlink(path.join(directory, 'outside.svg'), path.join(root, 'linked.svg'));
  expect(await workspace.imageFile('nested/note.md', '../pixel%20image.svg')).toBe(
    path.join(root, 'pixel image.svg'),
  );
  await expect(workspace.imageFile('note.md', '../outside.svg')).rejects.toThrow('inside');
  await expect(workspace.imageFile('note.md', 'linked.svg')).rejects.toThrow('inside');
  await expect(workspace.imageFile('note.md', 'note.md')).rejects.toThrow('image');
  await expect(workspace.imageFile('note.md', 'https://example.com/image.svg')).rejects.toThrow(
    'Invalid image path',
  );
});

test('keeps directory watching shallow while explicitly opened hidden notes receive external updates', async () => {
  const { root, workspace } = await fixture();
  await mkdir(path.join(root, 'node_modules/package/deep'), { recursive: true });
  await mkdir(path.join(root, '.hidden/deep'), { recursive: true });
  await mkdir(path.join(root, 'visible/deep'), { recursive: true });
  const hidden = path.join(root, '.hidden/deep/note.md');
  await writeFile(hidden, 'Hidden original\n');
  const info = await workspace.open('.hidden/deep/note.md');
  const handle = await workspace.repo.find<FileDoc>(info.url);
  await workspace.browse('.');
  const watcher = Reflect.get(workspace, 'watcher') as import('chokidar').FSWatcher;
  await expect.poll(() => Object.keys(watcher.getWatched())).toContain(root);
  expect(Object.keys(watcher.getWatched())).not.toContain(path.join(root, 'node_modules/package'));
  expect(Object.keys(watcher.getWatched())).not.toContain(path.join(root, 'visible/deep'));
  await writeFile(hidden, 'Hidden external update\n');
  await expect.poll(() => handle.doc().content).toBe('Hidden external update\n');
});

test('scopes recursive search, prunes hidden and generated directories, and bounds UTF-8 previews', async () => {
  const { root, workspace } = await fixture();
  for (const folder of ['one/.hidden', 'one/node_modules', 'two'])
    await mkdir(path.join(root, folder), { recursive: true });
  for (const file of [
    'one/visible.md',
    'one/.hidden/secret.md',
    'one/node_modules/generated.md',
    'two/other.md',
  ])
    await writeFile(path.join(root, file), '# Note\n');
  await workspace.open('one/.hidden/secret.md');
  expect(await workspace.list('one')).toEqual(['one/visible.md']);
  expect(await workspace.list()).toEqual(['note.md', 'one/visible.md', 'two/other.md']);
  const large = Buffer.concat([
    Buffer.from('a'.repeat(127_999)),
    Buffer.from('中文'.repeat(100_000)),
  ]);
  await writeFile(path.join(root, 'large.md'), large);
  expect(await workspace.preview('large.md')).toBe('a'.repeat(32_000));
  await writeFile(path.join(root, 'preview.md'), '\ufeff# Unicode 中文\r\nNext line\r\n');
  expect(await workspace.preview('preview.md')).toBe('# Unicode 中文\nNext line\n');
});

test('browses UTF-8 text with any extension while keeping Markdown-only listings available', async () => {
  const { root, directory, workspace } = await fixture();
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'config.json'), '{"label":"中文"}\n');
  await writeFile(path.join(root, 'Makefile'), 'all:\n\techo hello\n');
  await writeFile(path.join(root, 'nested/program.ts'), 'const title = "中文";\n');
  await writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0, 0xff]));
  await writeFile(path.join(root, 'bad.txt'), Buffer.from([0xc3]));
  await writeFile(path.join(directory, 'outside.txt'), 'Outside');
  await symlink(path.join(directory, 'outside.txt'), path.join(root, 'escape.txt'));
  expect((await workspace.browse('.')).map((entry) => entry.name)).toEqual(['nested', 'note.md']);
  expect((await workspace.browse('.', { text: true })).map((entry) => entry.name)).toEqual([
    'nested',
    'config.json',
    'Makefile',
    'note.md',
  ]);
  expect(await workspace.list('.', { text: true })).toEqual([
    'config.json',
    'Makefile',
    'nested/program.ts',
    'note.md',
  ]);
  await expect(workspace.open('escape.txt')).rejects.toThrow('outside');
  await expect(workspace.open('image.png')).rejects.toThrow();
  await expect(workspace.open('bad.txt')).rejects.toThrow();
  await expect(workspace.open('nested')).rejects.toThrow('text file');
  expect(await readFile(path.join(root, 'image.png'))).toEqual(Buffer.from([0x89, 0x50, 0, 0xff]));
});

test('opens prototype-like text file names and confines binary resources without CRDT import', async () => {
  const { directory, root, workspace } = await fixture();
  for (const name of ['constructor', 'toString', '__proto__']) {
    await writeFile(path.join(root, name), 'ordinary text\n');
    const info = await workspace.open(name);
    expect((await workspace.repo.find<FileDoc>(info.url)).doc().content).toBe('ordinary text\n');
  }
  const count = Object.keys(workspace.repo.handles).length;
  await writeFile(path.join(root, 'binary.pdf'), Buffer.from([0, 255, 10]));
  expect(
    (await workspace.browse('.', { extensions: ['pdf'] })).map((entry) => entry.name),
  ).toContain('binary.pdf');
  expect((await workspace.browse('.')).map((entry) => entry.name)).not.toContain('binary.pdf');
  expect(await workspace.inspect('./binary.pdf')).toMatchObject({
    path: 'binary.pdf',
    readOnly: true,
    size: 3,
  });
  expect(Object.keys(workspace.repo.handles)).toHaveLength(count);
  await writeFile(path.join(directory, 'outside.pdf'), 'outside');
  await symlink(path.join(directory, 'outside.pdf'), path.join(root, 'linked.pdf'));
  await expect(workspace.resourceFile('linked.pdf')).rejects.toThrow('outside');
  await expect(workspace.inspect('../outside.pdf')).rejects.toThrow('inside');
  await workspace.watchResource('binary.pdf', true);
  await workspace.watchResource('binary.pdf', false);
});
