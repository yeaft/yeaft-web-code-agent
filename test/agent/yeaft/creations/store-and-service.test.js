import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import ctx from '../../../../agent/context.js';
import { resolveCreationWorkspaceRoot } from '../../../../agent/yeaft/creations/bridge.js';
import { resolveWorkItemPath, supportsCreationWorkbenchFiles, withCreationFiles } from '../../../../agent/workbench/work-item-path.js';
import { handleCopyFiles, handleCreateFile, handleDeleteFiles, handleListDirectory, handleMoveFiles, handleReadFile, handleUploadToDir, handleVideoChunk, handleVideoMetadata, handleWriteFile }
  from '../../../../agent/workbench/file-ops.js';
import { BUFFERABLE_TYPES } from '../../../../agent/connection/buffer.js';
import { createCreationBridge, createCreationService, createCreationStore, parseSource } from '../../../../agent/yeaft/creations/index.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, mkdir: vi.fn(fs.mkdir), open: vi.fn(fs.open), link: vi.fn(fs.link), unlink: vi.fn(fs.unlink) };
});

let dir;
let service;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yeaft-creation-'));
  service = createCreationService({ yeaftDir: dir, bootId: 'boot-a', mediaUrlFor: (id, kind, mediaId) => `/mock/${id}/${kind}/${mediaId}` });
  store = service.store;
});
afterEach(async () => {
  await service?.close();
  rmSync(dir, { recursive: true, force: true });
});
const req = (op, payload = {}) => service.request({ op, payload });
const b64 = value => Buffer.from(value).toString('base64');
const err = code => expect.objectContaining({ code });

describe('Creation folder workspaces', () => {
  it('defaults missing linkage on old records and validates, trims, and clears linkage', () => {
    const id = 'book';
    const defaults = { sessionId: null, projectId: null, rootDir: null };
    expect(store.createCreation({ id })).toMatchObject(defaults);
    store.run("UPDATE creations SET data=json_remove(data,'$.sessionId','$.projectId','$.rootDir') WHERE id=?", id);
    expect(store.getCreation(id)).toMatchObject(defaults);
    const folder = join(realpathSync(dir), 'external');
    mkdirSync(folder);
    const links = { sessionId: ' session:1 ', projectId: ' project-2 ', rootDir: `  ${folder}  ` };
    const canonical = { sessionId: 'session:1', projectId: 'project-2', rootDir: folder };
    expect(store.updateCreation(id, links)).toMatchObject(canonical);
    expect(store.updateCreation(id, { title: 'Renamed' })).toMatchObject(canonical);
    expect(store.createCreation({ ...links, id: 'linked' })).toMatchObject(canonical);
    expect(store.updateCreation(id, { sessionId: ' ', projectId: null, rootDir: null })).toMatchObject(defaults);
    for (const value of [1, 'invalid\0id', 'x'.repeat(257)]) {
      expect(() => store.updateCreation(id, { sessionId: value })).toThrow(err('INVALID_REQUEST'));
      expect(() => store.createCreation({ projectId: value })).toThrow(err('INVALID_REQUEST'));
    }
  });

  it('initializes a private folder, copies original sources, and leaves planning to the native Session by default', () => {
    const creationId = 'workspace-book';
    const { creation, initialTurn } = req('create_creation', {
      id: creationId, title: 'Sky', prompt: 'Draft the story', initializeFolder: true,
      files: [{ name: 'notes/scene.txt', data: b64('Scene one') }, { name: 'notes\\scene.txt', data: b64('Scene two') }],
    });
    const root = realpathSync(join(store.root, '_workspaces', creationId));
    expect(creation.rootDir).toBe(root);
    expect(initialTurn).toBeUndefined();
    expect(store.listRuns(creationId)).toEqual([]);
    for (const name of ['docs', 'images', 'videos', 'sources']) {
      const stat = statSync(join(root, name));
      expect(stat.isDirectory()).toBe(true);
      if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# Sky\n\nDraft the story\n');
    expect(readFileSync(join(root, 'sources', 'notes_scene.txt'), 'utf8')).toBe('Scene one');
    expect(readFileSync(join(root, 'sources', 'notes_scene-2.txt'), 'utf8')).toBe('Scene two');
    expect(() => store.transaction(() => {
      store.deleteCreation(creationId);
      expect(existsSync(root)).toBe(true);
      throw new Error('abort deletion');
    })).toThrow('abort deletion');
    req('delete_creation', { creationId, purgeWorkspace: true });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(store.root, '_creations', creationId))).toBe(false);
    expect(store.listCreations()).toEqual([]);
  });

  it('preserves user files in supplied folders and protects historically linked legacy workspaces', () => {
    const external = join(dir, 'external');
    mkdirSync(join(external, 'sources'), { recursive: true });
    writeFileSync(join(external, 'README.md'), 'User readme');
    writeFileSync(join(external, 'sources', 'Notes.txt'), 'User notes');
    const { creation } = req('create_creation', { id: 'provided', initializeFolder: true, rootDir: external, textSources: ['Upload'] });
    expect(creation.rootDir).toBe(realpathSync(external));
    expect(readFileSync(join(external, 'README.md'), 'utf8')).toBe('User readme');
    expect(readFileSync(join(external, 'sources', 'Notes.txt'), 'utf8')).toBe('User notes');
    expect(readFileSync(join(external, 'sources', 'Notes-2.txt'), 'utf8')).toBe('Upload');
    req('delete_creation', { creationId: 'provided', purgeWorkspace: true });
    expect(existsSync(join(external, 'README.md'))).toBe(true);

    const legacy = join(store.root, 'workspaces', 'legacy');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'keep.txt'), 'legacy data');
    store.createCreation({ id: 'legacy' });
    store.run("UPDATE creations SET data=json_set(data,'$.rootDir',?) WHERE id='legacy'", legacy);
    expect(store.resolveWorkspaceRoot('legacy')).toBe(legacy);
    store.deleteCreation('legacy');
    expect(readFileSync(join(legacy, 'keep.txt'), 'utf8')).toBe('legacy data');
  });

  it('rejects private storage roots and their ancestors with real sibling namespaces', () => {
    const namespace = ownerId => ({ yeaftDir: dir,
      namespaceKey: createHash('sha256').update(`server\0agent\0${ownerId}`).digest('hex').slice(0, 24),
      namespaceBinding: { ownerId, serverUrl: 'server', agentId: 'agent' } });
    const first = createCreationStore(namespace('first'));
    const second = createCreationStore(namespace('second'));
    try {
      first.createCreation({ id: 'book' });
      const sibling = second.createCreation({ id: 'book', initializeFolder: true }).rootDir;
      for (const rootDir of [second.root, sibling, first.creationsRoot, realpathSync(dir), dirname(realpathSync(dir))]) {
        expect(() => first.createCreation({ id: 'other', rootDir })).toThrow(err('INVALID_PATH'));
        expect(() => first.updateCreation('book', { rootDir })).toThrow(err('INVALID_PATH'));
        expect(() => first.ensureWorkspace('book', { rootDir })).toThrow(err('INVALID_PATH'));
        first.run("UPDATE creations SET data=json_set(data,'$.rootDir',?) WHERE id='book'", rootDir);
        expect(() => first.resolveWorkspaceRoot('book')).toThrow(err('INVALID_PATH'));
        first.run("UPDATE creations SET data=json_remove(data,'$.rootDir') WHERE id='book'");
      }
      first.run("UPDATE creations SET data=json_set(data,'$.rootDir',?) WHERE id='book'", sibling);
      first.deleteCreation('book');
      expect(readFileSync(join(sibling, 'README.md'), 'utf8')).toContain('Untitled creation');
    } finally { first.close(); second.close(); }
  });

  it('upgrades a legacy cache and allows the workspaces ID beside legacy workspace data', async () => {
    const legacy = join(store.root, 'workspaces', 'other-id');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'keep.txt'), 'legacy workspace');
    store.createCreation({ id: 'old' });
    const [source] = store.addSources('old', { textSources: ['legacy notes'] });
    const asset = store.saveAsset('old', { ext: 'md', content: 'legacy asset' });
    renameSync(join(store.root, '_creations', 'old'), join(store.root, 'old'));
    store.db.exec('ALTER TABLE creations DROP COLUMN cache_dir');
    const reader = createCreationStore({ yeaftDir: dir, readOnly: true });
    try { expect(reader.getSource('old', source.id).chunks[0].text).toBe('legacy notes'); }
    finally { reader.close(); }
    await service.close();
    service = createCreationService({ yeaftDir: dir });
    store = service.store;
    expect(store.one("SELECT cache_dir FROM creations WHERE id='old'").cache_dir).toBeNull();
    expect(store.readMediaRange('old', 'asset', asset.id).bytes.toString()).toBe('legacy asset');
    const workspaces = store.createCreation({ id: 'workspaces', initializeFolder: true });
    expect(workspaces.rootDir).toBe(join(store.root, '_workspaces', 'workspaces'));
    const [current] = store.addSources('workspaces', { textSources: ['new cache'] });
    const cache = join(store.root, '_creations', 'workspaces');
    expect(store.one("SELECT cache_dir FROM creations WHERE id='workspaces'").cache_dir).toBe(cache);
    expect(readFileSync(join(cache, 'sources', current.id, 'original'), 'utf8')).toBe('new cache');
    store.deleteCreation('old');
    expect(existsSync(join(store.root, 'old'))).toBe(false);
    store.deleteCreation('workspaces');
    expect(existsSync(cache)).toBe(false);
    expect(readFileSync(join(legacy, 'keep.txt'), 'utf8')).toBe('legacy workspace');
  });

  it('migrates only the recorded payloads of a pre-upgrade workspaces Creation', async () => {
    const id = 'workspaces';
    const legacy = join(store.root, id);
    const cache = join(store.root, '_creations', id);
    store.createCreation({ id });
    const [source] = store.addSources(id, { textSources: ['legacy notes'] });
    const asset = store.saveAsset(id, { ext: 'md', content: 'legacy asset' });
    const node = store.createNode(id, { id: 'draft', content: 'legacy revision' });
    renameSync(cache, legacy);
    const sibling = join(legacy, 'other-id', 'README.md');
    mkdirSync(dirname(sibling));
    writeFileSync(sibling, 'sibling workspace');
    const originalSibling = statSync(sibling);
    const unrelated = join(legacy, 'sources', 'unrecorded.txt');
    writeFileSync(unrelated, 'leave alone');
    store.db.exec('ALTER TABLE creations DROP COLUMN cache_dir');
    await service.close();
    service = createCreationService({ yeaftDir: dir });
    store = service.store;
    expect(store.one('SELECT cache_dir FROM creations WHERE id=?', id).cache_dir).toBe(cache);
    expect(store.getSource(id, source.id).chunks[0].text).toBe('legacy notes');
    expect(store.readMediaRange(id, 'source', source.id).bytes.toString()).toBe('legacy notes');
    expect(store.readMediaRange(id, 'asset', asset.id).bytes.toString()).toBe('legacy asset');
    expect(store.getRevision(id, node.id, node.currentRevId).content).toBe('legacy revision');
    expect(readdirSync(join(cache, 'sources'))).toEqual([source.id]);
    expect(existsSync(join(cache, 'other-id'))).toBe(false);
    store.deleteCreation(id, { purgeWorkspace: true });
    expect(existsSync(cache)).toBe(false);
    expect(readFileSync(unrelated, 'utf8')).toBe('leave alone');
    expect(readFileSync(sibling, 'utf8')).toBe('sibling workspace');
    expect(statSync(sibling)).toMatchObject({ ino: originalSibling.ino, mtimeMs: originalSibling.mtimeMs });
  });

  it('reclaims caches by default and only purges generated workspaces on explicit opt-in', () => {
    const external = join(dir, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'keep.txt'), 'user data');
    for (const id of ['generated', 'purged', 'external']) {
      const { rootDir } = store.createCreation({ id, initializeFolder: true, ...(id === 'external' && { rootDir: external }) });
      store.addSources(id, { textSources: ['source'] });
      store.createNode(id, { id: 'draft', content: 'revision' });
      store.saveAsset(id, { ext: 'md', content: 'export' }, { exportFile: true });
      const cache = join(store.root, '_creations', id);
      expect(readdirSync(cache).sort()).toEqual(['artifacts', 'assets', 'sources']);
      const doc = join(rootDir, 'docs', 'keep.md');
      writeFileSync(doc, 'user draft');
      if (id === 'generated') store.deleteCreation(id);
      else store.deleteCreation(id, { purgeWorkspace: true });
      expect(existsSync(cache)).toBe(false);
      if (id === 'purged') expect(existsSync(rootDir)).toBe(false);
      else expect(readFileSync(doc, 'utf8')).toBe('user draft');
      expect(store.createCreation({ id }).rootDir).toBeNull();
    }
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('user data');
  });

  it.each(['protected', 'shared'])('preserves a %s generated workspace', mode => {
    const { rootDir } = store.createCreation({ id: 'generated', initializeFolder: true });
    if (mode === 'protected') store.run('INSERT INTO protected_workspaces VALUES (?)', rootDir);
    else {
      store.createCreation({ id: 'other' });
      // Even without a history row, another live root reference is enough.
      store.run("UPDATE creations SET data=json_set(data,'$.rootDir',?) WHERE id='other'", rootDir);
      store.run('DELETE FROM protected_workspaces WHERE root_dir=?', rootDir);
    }
    store.deleteCreation('generated', { purgeWorkspace: true });
    expect(readFileSync(join(rootDir, 'README.md'), 'utf8')).toContain('Untitled creation');
  });

  it.each(['edited', 'conflict'])('recovers a real interrupted external publication (%s)', mode => {
    const id = 'journaled';
    const rootDir = join(dir, 'external');
    mkdirSync(rootDir);
    store.createCreation({ id });
    for (const [nodeId, title] of [['first', 'First'], ['second', 'Second'], ['third', 'Third']]) {
      store.createNode(id, { id: nodeId, title, content: `Draft ${nodeId}` });
    }
    // Kill publication after the kernel link, before SQLite can record it.
    const module = new URL('../../../../agent/yeaft/creations/store.js', import.meta.url).href;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createCreationStore } from ${JSON.stringify(module)};
      const { linkSync } = fs;
      fs.linkSync = (temp, path) => {
        linkSync(temp, path);
        if (path.endsWith('Second.md')) process.exit(79);
      };
      syncBuiltinESMExports();
      createCreationStore({ yeaftDir: ${JSON.stringify(dir)} }).ensureWorkspace(${JSON.stringify(id)}, { rootDir: ${JSON.stringify(rootDir)} });
    `], { encoding: 'utf8', timeout: 10000 });
    expect(crashed.status, crashed.stderr).toBe(79);
    const journal = () => store.one('SELECT * FROM creation_materialization_journal WHERE creation_id=?', id);
    const row = journal();
    expect(row.target_dir).toBe(rootDir);
    const [temp] = JSON.parse(row.temp_files_json);
    const docs = join(rootDir, 'docs');
    const first = join(docs, 'First.md');
    const second = join(docs, 'Second.md');
    const third = join(docs, 'Third.md');
    expect(statSync(temp).ino).toBe(statSync(second).ino);
    expect(JSON.parse(row.published_outputs_json)).toMatchObject({ 'node:first': join('docs', 'First.md') });
    expect(JSON.parse(row.planned_outputs_json)['node:third']).toEqual({ relPath: join('docs', 'Third.md'),
      sha256: createHash('sha256').update('Draft third').digest('hex') });
    writeFileSync(first, 'edited saved draft');
    writeFileSync(second, 'edited before publication was recorded');
    if (mode === 'conflict') {
      writeFileSync(third, 'third-party draft');
      expect(() => store.ensureWorkspace(id, { rootDir })).toThrow(err('CONFLICT'));
      expect(store.getCreation(id).rootDir).toBeNull();
      expect(journal()).toBeDefined();
      expect(readFileSync(third, 'utf8')).toBe('third-party draft');
    } else {
      expect(store.ensureWorkspace(id, { rootDir })).toMatchObject({ rootDir, materialized: true });
      expect(store.getCreation(id).rootDir).toBe(rootDir);
      expect(journal()).toBeUndefined();
      expect(readFileSync(third, 'utf8')).toBe('Draft third');
    }
    expect(existsSync(temp)).toBe(false);
    expect(readdirSync(docs).sort()).toEqual(['First.md', 'Second.md', 'Third.md']);
    expect(readFileSync(first, 'utf8')).toBe('edited saved draft');
    expect(readFileSync(second, 'utf8')).toBe('edited before publication was recorded');
  });

  it.each(['retry', 'delete'])('handles %s after external create_creation dies publishing its initial source', outcome => {
    const id = 'journaled-import';
    const rootDir = join(dir, 'external');
    mkdirSync(rootDir);
    const payload = { id, importKey: 'upload:journaled', initializeFolder: true, rootDir, title: 'Journaled',
      textSources: [{ name: 'Initial.txt', text: 'raw source' }], starterNode: { title: 'Draft', content: 'initial draft' } };
    const module = new URL('../../../../agent/yeaft/creations/service.js', import.meta.url).href;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createCreationService } from ${JSON.stringify(module)};
      const { linkSync } = fs;
      fs.linkSync = (temp, path) => {
        linkSync(temp, path);
        if (path.endsWith('Initial.txt')) process.exit(79);
      };
      syncBuiltinESMExports();
      createCreationService({ yeaftDir: ${JSON.stringify(dir)} }).request({ op: 'create_creation', payload: ${JSON.stringify(payload)} });
    `], { encoding: 'utf8', timeout: 10000 });
    expect(crashed.status, crashed.stderr).toBe(79);
    const journal = () => store.one('SELECT * FROM creation_materialization_journal WHERE creation_id=?', id);
    expect(store.getCreation(id).rootDir).toBeNull();
    expect(store.one('SELECT creation_id FROM creation_import_keys WHERE import_key=?', payload.importKey)?.creation_id).toBe(id);
    const [source] = store.listSources(id);
    expect(store.readMediaRange(id, 'source', source.id).bytes.toString()).toBe('raw source');
    const row = journal();
    expect(row.target_dir).toBe(rootDir);
    expect(JSON.parse(row.published_outputs_json)).toMatchObject({ readme: 'README.md' });
    const [temp] = JSON.parse(row.temp_files_json);
    const sources = join(rootDir, 'sources');
    const published = join(sources, 'Initial.txt');
    expect(statSync(temp).ino).toBe(statSync(published).ino);
    // Reconciliation must keep edits made after the initial hard link was published.
    writeFileSync(published, 'user edited');
    if (outcome === 'retry') {
      const retry = req('create_creation', { ...payload, id: 'ignored-on-retry', textSources: ['do not ingest again'] });
      expect(retry).toMatchObject({ deduplicated: true, creation: { id, rootDir } });
      expect(retry.sources.map(item => item.id)).toEqual([source.id]);
      expect(retry.nodes).toHaveLength(1);
      expect(store.listCreations()).toHaveLength(1);
      expect(readFileSync(join(rootDir, 'docs', 'Draft.md'), 'utf8')).toBe('initial draft');
    } else {
      const outsideTemp = join(dir, '.creation-tmp-outside');
      const unownedFile = join(rootDir, 'user-file');
      const symbolicTemp = join(rootDir, '.creation-tmp-symlink');
      writeFileSync(outsideTemp, 'outside');
      writeFileSync(unownedFile, 'inside');
      symlinkSync(outsideTemp, symbolicTemp);
      store.run('UPDATE creation_materialization_journal SET temp_files_json=? WHERE creation_id=?',
        JSON.stringify([temp, outsideTemp, unownedFile, symbolicTemp]), id);
      expect(store.deleteCreation(id)).toEqual({ deleted: true, id });
      expect(store.listCreations()).toEqual([]);
      expect(existsSync(join(store.root, '_creations', id))).toBe(false);
      expect(readFileSync(outsideTemp, 'utf8')).toBe('outside');
      expect(readFileSync(unownedFile, 'utf8')).toBe('inside');
      expect(lstatSync(symbolicTemp).isSymbolicLink()).toBe(true);
    }
    expect(journal()).toBeUndefined();
    expect(existsSync(temp)).toBe(false);
    expect(readdirSync(sources)).toEqual(['Initial.txt']);
    expect(readFileSync(published, 'utf8')).toBe('user edited');
    expect(readFileSync(join(rootDir, 'README.md'), 'utf8')).toBe('# Journaled\n\n\n');
    expect(readdirSync(rootDir).filter(name => name.startsWith('.creation-tmp-'))).toEqual(outcome === 'delete' ? ['.creation-tmp-symlink'] : []);
  });

  it.each(['external', 'generated'])('reconciles a partially published %s workspace without suffixing matching files', async location => {
    const id = 'interrupted';
    store.createCreation({ id });
    store.createNode(id, { title: 'Doc', content: '# Draft' });
    store.createNode(id, { title: 'Other', content: 'Missing output' });
    const image = store.saveAsset(id, { ext: 'svg', content: '<svg></svg>' });
    const rootDir = location === 'external' ? join(dir, 'outside') : join(store.root, '_workspaces', id);
    mkdirSync(join(rootDir, 'docs'), { recursive: true });
    mkdirSync(join(rootDir, 'images'));
    writeFileSync(join(rootDir, 'docs', 'Doc.md'), 'User draft');
    writeFileSync(join(rootDir, 'docs', 'Doc-2.md'), '# Draft');
    writeFileSync(join(rootDir, 'images', `${image.id}.svg`), '<svg></svg>');
    const stale = join(dirname(rootDir), `.staging-${id}.stale`);
    if (location === 'generated') mkdirSync(stale);
    await service.close();
    service = createCreationService({ yeaftDir: dir });
    store = service.store;
    expect(store.getCreation(id).rootDir).toBeNull();
    expect(store.ensureWorkspace(id, location === 'external' ? { rootDir } : {})).toMatchObject({ rootDir, materialized: true });
    expect(readdirSync(join(rootDir, 'docs')).sort()).toEqual(['Doc-2.md', 'Doc.md', 'Other.md']);
    expect(readdirSync(join(rootDir, 'images'))).toEqual([`${image.id}.svg`]);
    expect(readFileSync(join(rootDir, 'docs', 'Doc.md'), 'utf8')).toBe('User draft');
    expect(existsSync(stale)).toBe(false);
    expect(store.ensureWorkspace(id)).toMatchObject({ rootDir, materialized: false });
  });

  it('rejects new cache-tree links on create, update and workspace setup', () => {
    store.createCreation({ id: 'cache-owner' });
    store.createCreation({ id: 'linked' });
    const rootDir = join(store.root, 'cache-owner', 'sources');
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, 'keep.txt'), 'workspace data');
    for (const path of [rootDir, store.root, join(store.root, 'cache-owner', 'missing')]) {
      expect(() => store.createCreation({ id: 'new-link', rootDir: path })).toThrow(err('INVALID_PATH'));
      expect(() => store.updateCreation('linked', { rootDir: path })).toThrow(err('INVALID_PATH'));
      expect(() => store.ensureWorkspace('linked', { rootDir: path })).toThrow(err('INVALID_PATH'));
    }
    expect(store.getCreation('linked').rootDir).toBeNull();
    expect(readdirSync(rootDir)).toEqual(['keep.txt']);
  });

  it.each([['sources', false], ['sources/nested', true], ['custom-ws', false]])(
    'preserves legacy %s workspace after its link is removed (unlink=%s) and the cache owner is deleted',
    async (workspace, unlink) => {
      store.createCreation({ id: 'cache-owner' });
      store.createCreation({ id: 'linked' });
      store.run("UPDATE creations SET cache_dir=NULL WHERE id='cache-owner'");
      const cache = join(store.root, 'cache-owner');
      const rootDir = join(cache, workspace);
      mkdirSync(rootDir, { recursive: true });
      writeFileSync(join(rootDir, 'keep.txt'), 'workspace data without a marker');
      mkdirSync(join(cache, 'exports'));
      writeFileSync(join(cache, 'exports', 'discard.txt'), 'internal cache');
      mkdirSync(join(cache, 'assets', 'marked'), { recursive: true });
      writeFileSync(join(cache, 'assets', 'marked', 'README.md'), 'unregistered workspace marker');

      // Emulate the pre-guard schema and upgrade with a legacy root already stored.
      store.db.exec(`DROP TRIGGER creation_workspace_insert; DROP TRIGGER creation_workspace_update;
        DROP TRIGGER creation_workspace_delete; DROP TABLE protected_workspaces;`);
      store.run("UPDATE creations SET data=json_set(data,'$.rootDir',?) WHERE id='linked'", rootDir);
      const reopen = async () => {
        await service.close();
        service = createCreationService({ yeaftDir: dir });
        store = service.store;
      };
      await reopen();
      expect(store.one('SELECT root_dir FROM protected_workspaces WHERE root_dir=?', rootDir)).toMatchObject({ root_dir: rootDir });
      if (unlink) store.updateCreation('linked', { rootDir: null });
      store.deleteCreation('linked');
      await reopen();
      store.deleteCreation('cache-owner');
      expect(readFileSync(join(rootDir, 'keep.txt'), 'utf8')).toBe('workspace data without a marker');
      expect(readFileSync(join(cache, 'assets', 'marked', 'README.md'), 'utf8')).toBe('unregistered workspace marker');
      expect(readFileSync(join(cache, 'exports', 'discard.txt'), 'utf8')).toBe('internal cache');
      expect(store.listCreations()).toEqual([]);
    },
  );

  it.each(['directory', 'symlink', 'ancestor symlink'])('preserves workspace bytes after replacement by a %s', replacement => {
    const id = 'replaced';
    const { rootDir } = store.createCreation({ id, initializeFolder: true });
    const moved = join(dir, 'moved');
    renameSync(rootDir, moved);
    const target = join(dir, 'target');
    const replacementDir = replacement === 'directory' ? rootDir : replacement === 'symlink' ? target : join(target, id);
    mkdirSync(replacementDir, { recursive: true });
    writeFileSync(join(replacementDir, 'keep.txt'), 'replacement data');
    if (replacement === 'symlink') symlinkSync(target, rootDir, 'dir');
    if (replacement === 'ancestor symlink') {
      const parent = dirname(rootDir);
      rmSync(parent, { recursive: true });
      symlinkSync(target, parent, 'dir');
    }
    store.deleteCreation(id, { purgeWorkspace: true });
    expect(readFileSync(join(replacementDir, 'keep.txt'), 'utf8')).toBe('replacement data');
    expect(readFileSync(join(moved, 'README.md'), 'utf8')).toContain('# Untitled creation');
    if (replacement === 'symlink') expect(lstatSync(rootDir).isSymbolicLink()).toBe(true);
  });

  it('rejects an existing linked workspace replaced by a symlink even with a different requested folder', () => {
    const id = 'linked';
    const { rootDir } = store.createCreation({ id, initializeFolder: true });
    const moved = join(dir, 'moved');
    renameSync(rootDir, moved);
    symlinkSync(moved, rootDir, 'dir');
    for (const requested of [undefined, moved]) {
      expect(() => req('ensure_workspace', { creationId: id, rootDir: requested })).toThrow(err('INVALID_REQUEST'));
    }
    expect(store.getCreation(id).rootDir).toBe(rootDir);
  });

  it.each(['docs', 'docs/Chapter', 'docs/Chapter/Draft.md', 'README.md'])('rejects workspace materialization through symlink %s', relative => {
    const id = 'legacy';
    store.createCreation({ id });
    store.createNode(id, { id: 'chapter', title: 'Chapter', type: 'folder' });
    store.createNode(id, { parentId: 'chapter', title: 'Draft', content: '# Legacy draft' });
    const rootDir = join(dir, 'workspace');
    const target = join(dir, 'target');
    const isFile = relative.endsWith('.md');
    const parts = relative.split('/');
    mkdirSync(join(rootDir, ...parts.slice(0, -1)), { recursive: true });
    if (isFile) writeFileSync(target, 'unchanged');
    else mkdirSync(target);
    symlinkSync(target, join(rootDir, ...parts), isFile ? 'file' : 'dir');
    expect(() => req('ensure_workspace', { creationId: id, rootDir })).toThrow(err('INVALID_PATH'));
    expect(store.getCreation(id).rootDir).toBeNull();
    if (isFile) expect(readFileSync(target, 'utf8')).toBe('unchanged');
    else expect(readdirSync(target)).toEqual([]);
  });

  it('rolls back copies and workspace setup on failure and will not follow a sources directory symlink', () => {
    const id = 'rejected';
    const payload = { id, initializeFolder: true, files: [
      { name: 'valid.txt', data: b64('first') }, { name: 'sub/../unsafe.txt', data: b64('second') },
    ] };
    expect(() => req('create_creation', payload)).toThrow(err('INVALID_REQUEST'));
    expect(existsSync(join(store.root, '_workspaces', id))).toBe(false);
    expect(store.listCreations()).toEqual([]);
    const rootDir = join(dir, 'external');
    mkdirSync(rootDir);
    expect(() => req('create_creation', { ...payload, rootDir })).toThrow(err('INVALID_REQUEST'));
    expect(readdirSync(rootDir)).toEqual([]);
    symlinkSync(dir, join(rootDir, 'sources'), 'dir');
    expect(() => req('create_creation', { id, initializeFolder: true, rootDir, textSources: ['Upload'] })).toThrow(err('INVALID_PATH'));
    expect(existsSync(join(dir, 'Notes.txt'))).toBe(false);
  });

  it('materializes legacy nodes, canon and binary media without clobbering files; it only emits once', async () => {
    await service.close();
    const events = [];
    service = createCreationService({ yeaftDir: dir, emitEvent: event => events.push(event) });
    store = service.store;
    const id = 'legacy';
    store.createCreation({ id, title: 'Legacy' });
    store.createNode(id, { id: 'part', type: 'folder', title: 'Part / One' });
    store.createNode(id, { parentId: 'part', title: 'Chapter', content: '# Chapter' });
    store.createNode(id, { title: 'Outline only', outlineMd: 'Not written yet' });
    store.createNode(id, { title: 'Slides', modality: 'slide_deck', content: { slides: ['Slide'] } });
    store.upsertCanon(id, { title: 'The Rule', contentMd: 'The rule text' });
    store.addSources(id, { textSources: ['Legacy notes'] });
    const image = store.saveAsset(id, { ext: 'svg', content: '<svg></svg>' });
    const asset = store.saveAsset(id, { ext: 'html', content: '<p>Other</p>' });
    // Historical media can include video assets not accepted by the current asset writer.
    const video = Buffer.from([0, 255, 13]);
    writeFileSync(join(store.root, '_creations', id, 'assets', 'clip.mp4'), video);
    store.run('INSERT INTO creation_assets VALUES (?,?,?)', id, 'clip', JSON.stringify({ id: 'clip', ext: 'mp4' }));
    store.saveAsset(id, { ext: 'md', content: 'An export' }, { exportFile: true });
    store.saveAsset(id, { ext: 'json', content: '{}' }, { exportFile: true });
    const rootDir = join(dir, 'destination');
    mkdirSync(join(rootDir, 'docs', 'Part _ One'), { recursive: true });
    writeFileSync(join(rootDir, 'docs', 'Part _ One', 'Chapter.md'), 'Existing draft');
    const result = req('ensure_workspace', { creationId: id, rootDir });
    expect(result).toMatchObject({ creation: { id, rootDir }, rootDir, materialized: true });
    const read = (...parts) => readFileSync(join(rootDir, ...parts), 'utf8');
    expect(read('docs', 'Part _ One', 'Chapter.md')).toBe('Existing draft');
    expect(read('docs', 'Part _ One', 'Chapter-2.md')).toBe('# Chapter');
    expect(existsSync(join(rootDir, 'docs', 'Outline only.md'))).toBe(false);
    expect(read('docs', 'Slides.md')).toBe('# Slides\n\n## Slide 1: Slide\n');
    expect(read('docs', 'canon', 'The Rule.md')).toBe('The rule text');
    expect(read('sources', 'Notes.txt')).toBe('Legacy notes');
    expect(read('images', `${image.id}.svg`)).toBe('<svg></svg>');
    expect(readFileSync(join(rootDir, 'videos', 'clip.mp4'))).toEqual(video);
    expect(readdirSync(join(rootDir, 'assets'))).toEqual([`${asset.id}.html`]);
    expect(req('ensure_workspace', { creationId: id })).toEqual({ ...result, materialized: false });
    expect(readdirSync(join(rootDir, 'docs', 'Part _ One')).sort()).toEqual(['Chapter-2.md', 'Chapter.md']);
    expect(events).toEqual([{ type: 'creation_upserted', creationId: id, creation: result.creation }]);
  });

  it('migrates legacy reader formats to Markdown with links to actual workspace media', () => {
    const id = 'structured';
    store.createCreation({ id });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Example</title></svg>';
    const image = store.saveAsset(id, { ext: 'svg', content: svg });
    const [source] = store.addSources(id, { files: [{ name: 'Source preview.svg', mimeType: 'image/svg+xml', data: b64(svg) }] });
    const video = Buffer.from('legacy video bytes');
    writeFileSync(join(store.root, '_creations', id, 'assets', 'clip.mp4'), video);
    store.run('INSERT INTO creation_assets VALUES (?,?,?)', id, 'clip', JSON.stringify({ id: 'clip', ext: 'mp4', name: 'Scene (cut).mp4' }));
    store.createNode(id, { title: 'Slides', modality: 'slide_deck', content: JSON.stringify({ title: 'The Deck', slides: [
      { title: 'Launch', bullets: ['First point', 'Second point'], body: 'Slide body', blocks: [{ text: 'Body block' }],
        imageAssetId: image.id, caption: 'Launch image', speakerNotes: 'Pause here.\nThen continue.' },
      { title: 'Missing image', imageAssetId: 'missing' },
    ] }) });
    store.createNode(id, { id: 'folder', title: 'Collection', type: 'folder' });
    store.createNode(id, { id: 'gallery', parentId: 'folder', title: 'Gallery', modality: 'image_gallery', content: { frames: [
      { title: 'Cover', assetId: image.id, caption: 'Cover caption', notes: 'Cover notes' },
      { title: 'Preview', sourceId: source.id }, { title: 'Sketch', svgMarkup: svg },
    ] } });
    store.createNode(id, { title: 'Episode', modality: 'video_episode', content: { videoAssetId: 'clip', posterAssetId: image.id, scenes: [
      { title: 'Intro', durationSec: 5, narration: 'Intro script.', caption: 'Intro subtitles.', assetId: image.id },
      { title: 'Finale', durationSec: 8, narration: 'Finale script.', subtitles: 'Finale subtitles.', assetId: 'clip' },
    ] } });
    const rootDir = join(dir, 'workspace');
    mkdirSync(join(rootDir, 'images'), { recursive: true });
    writeFileSync(join(rootDir, 'images', `${image.id}.svg`), 'Existing image');
    expect(req('ensure_workspace', { creationId: id, rootDir })).toMatchObject({ rootDir, materialized: true });
    const read = (...parts) => readFileSync(join(rootDir, ...parts), 'utf8');
    const deck = read('docs', 'Slides.md');
    for (const text of ['# The Deck', '## Slide 1: Launch', '## Slide 2: Missing image', '- First point\n- Second point',
      'Slide body', 'Body block', `![Launch image](../images/${image.id}-2.svg)`, '> Speaker Notes: Pause here.\n> Then continue.']) {
      expect(deck).toContain(text);
    }
    expect(deck.match(/!\[/g)).toHaveLength(1);
    const gallery = read('docs', 'Collection', 'Gallery.md');
    for (const text of ['## Cover', `![](../../images/${image.id}-2.svg)`, 'Cover caption', '**Notes:** Cover notes',
      '![](../../images/Source%20preview.svg)', '![](../../images/gallery-frame-3.svg)']) expect(gallery).toContain(text);
    const episode = read('docs', 'Episode.md');
    for (const text of ['## Scene 1: Intro', '00:00–00:05', 'Intro script.', 'Intro subtitles.',
      '## Scene 2: Finale', '00:05–00:13', 'Finale script.', 'Finale subtitles.', '[Episode video](../videos/Scene%20%28cut%29.mp4)',
      '[Scene video](../videos/Scene%20%28cut%29.mp4)', `![Episode poster](../images/${image.id}-2.svg)`,
      `![Scene frame](../images/${image.id}-2.svg)`]) expect(episode).toContain(text);
    expect(read('images', `${image.id}.svg`)).toBe('Existing image');
    for (const file of [`${image.id}-2.svg`, 'Source preview.svg', 'gallery-frame-3.svg']) expect(read('images', file)).toBe(svg);
    expect(readFileSync(join(rootDir, 'videos', 'Scene (cut).mp4'))).toEqual(video);
    expect(readdirSync(join(rootDir, 'docs')).sort()).toEqual(['Collection', 'Episode.md', 'Slides.md']);
  });

  it('finds canonical and missing linked paths, misses unrelated folders, and can recreate a missing workspace', () => {
    const rootDir = join(dir, 'old');
    mkdirSync(rootDir);
    const id = 'legacy';
    const creation = store.createCreation({ id, rootDir });
    const alias = join(dir, 'alias');
    symlinkSync(rootDir, alias, 'dir');
    expect(() => req('find_by_folder', { rootDir: alias })).toThrow(err('INVALID_REQUEST'));
    expect(req('find_by_folder', { rootDir: `  ${rootDir}  ` })).toEqual({ creation });
    expect(req('find_by_folder', { rootDir: dir })).toEqual({ creation: null });
    expect(req('find_by_folder', { rootDir: join(dir, 'missing', 'nested') })).toEqual({ creation: null });
    expect(() => req('find_by_folder', { rootDir: join(alias, 'missing') })).toThrow(err('INVALID_REQUEST'));
    rmSync(rootDir, { recursive: true });
    expect(() => req('find_by_folder', { rootDir: alias })).toThrow(err('INVALID_REQUEST'));
    expect(req('find_by_folder', { rootDir })).toEqual({ creation });
    const workspace = join(realpathSync(store.root), '_workspaces', id);
    expect(req('ensure_workspace', { creationId: id })).toMatchObject({ rootDir: workspace, materialized: true });
    expect(req('find_by_folder', { rootDir: workspace }).creation.id).toBe(id);
  });

  it('rejects invalid and non-directory rootDir values', () => {
    store.createCreation({ id: 'book' });
    const file = join(dir, 'file');
    writeFileSync(file, 'not a directory');
    for (const rootDir of [12, '', '  ', 'invalid\0path', 'x'.repeat(4097), file, join(file, 'nested'), join(dir, 'missing')]) {
      expect(() => store.createCreation({ rootDir })).toThrow(err('INVALID_REQUEST'));
      expect(() => store.updateCreation('book', { rootDir })).toThrow(err('INVALID_REQUEST'));
      expect(() => store.ensureWorkspace('book', { rootDir })).toThrow(err('INVALID_REQUEST'));
    }
    for (const rootDir of [undefined, null, 12, '', ' ', 'invalid\0path', 'x'.repeat(4097), file, join(file, 'nested')]) {
      expect(() => req('find_by_folder', { rootDir })).toThrow(err('INVALID_REQUEST'));
    }
  });
});

describe('Creations durable store and operations', () => {
  it('uses WAL/FKs, provides summaries, scopes data, and persists across reopen', async () => {
    expect(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(store.db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
    const { creation, thread } = req('create_creation', { id: 'sky', title: 'Sky', prompt: 'Mission', autoPlan: false, starterNode: true });
    expect(creation).toMatchObject({ kind: 'book', modality: 'markdown_doc', mission: 'Mission', unitCount: 1, hasReadableContent: false, placement: { arm: 0 } });
    expect(req('update_creation', { creationId: 'sky', patch: { title: 'Night Sky' } }).creation.title).toBe('Night Sky');
    const other = req('create_creation', { kind: 'video', title: 'Film' });
    expect(other.creation.placement.arm).toBe(3);
    expect(() => req('get_thread', { creationId: other.creation.id, threadId: thread.id })).toThrow(err('NOT_FOUND'));
    expect(() => req('create_creation', { id: 'oops', starterNode: { parentId: 'missing' }, textSources: ['rollback'] })).toThrow(err('NOT_FOUND'));
    expect(() => req('get_creation', { creationId: 'oops' })).toThrow(err('NOT_FOUND'));
    expect(req('create_creation', { id: 'oops' }).creation.id).toBe('oops');
    req('delete_creation', { creationId: 'oops' });
    await service.close();
    service = createCreationService({ yeaftDir: dir });
    expect(req('get_creation', { creationId: 'sky' })).toMatchObject({ creation: { title: 'Night Sky' }, thread: { id: thread.id } });
    expect(req('list_creations').creations).toHaveLength(2);
    expect(req('delete_creation', { creationId: 'sky' })).toMatchObject({ deleted: true });
    expect(req('list_creations').creations).toHaveLength(1);
    expect(() => req('constructor')).toThrow(err('UNSUPPORTED'));
  });

  it('scopes FTS5 and updates/deletes index records; AI cannot write locked Canon', () => {
    store.createCreation({ id: 'a' });
    store.createCreation({ id: 'b' });
    const { canon } = req('upsert_canon', { creationId: 'a', id: 'lore', type: 'rule', title: 'Sentinel', contentMd: 'Maple keep', lockedByUser: true });
    store.upsertCanon('b', { id: 'lore', title: 'Maple foreign' });
    expect(store.recallCanon('a', 'Maple')).toEqual([canon]);
    expect(store.recallCanon('a', '" ) OR *')).toEqual([]);
    expect(() => store.upsertCanon('a', { id: 'lore', lockedByUser: false, contentMd: 'Override' }, { actor: 'ai' })).toThrow(err('LOCKED'));
    req('upsert_canon', { creationId: 'a', canon: { id: 'lore', contentMd: 'Cedar keep' } });
    expect(store.recallCanon('a', 'Maple')).toEqual([]);
    expect(store.recallCanon('a', 'Cedar')).toMatchObject([{ id: 'lore', lockedByUser: true }]);
    req('delete_canon', { creationId: 'a', canonId: 'lore' });
    expect(store.recallCanon('a', 'Cedar')).toEqual([]);
    store.deleteCreation('b');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM creation_canon_fts').get().n).toBe(0);
  });

  it('maintains the node tree, immutable revisions, optimistic conflicts and restores', () => {
    req('create_creation', { id: 'book', kind: 'book', title: 'Epic' });
    const create = node => req('create_node', { creationId: 'book', node }).node;
    create({ id: 'vol1', title: 'Volume One', type: 'folder' });
    create({ id: 'vol2', title: 'Volume Two', type: 'folder' });
    create({ id: 'c1', parentId: 'vol1', title: 'Chapter One' });
    const first = create({ id: 'c2', parentId: 'vol1', title: 'Chapter Two', content: 'One original sentence' });
    create({ id: 'c3', parentId: 'vol2', title: 'Chapter Three', outlineMd: 'Future plot' });
    expect(req('reorder_nodes', { creationId: 'book', parentId: 'vol1', orderedIds: ['c2', 'c1'] }).nodes.filter(n => n.parentId === 'vol1').map(n => n.id)).toEqual(['c2', 'c1']);
    expect(store.getStructure('book').map(n => n.children.map(child => child.id))).toEqual([['c2', 'c1'], ['c3']]);
    expect(() => req('reorder_nodes', { creationId: 'book', parentId: 'vol1', nodeIds: ['c2', 'c2'] })).toThrow(err('INVALID_REQUEST'));
    const second = req('update_node', { creationId: 'book', nodeId: 'c2', baseRevId: first.currentRevId, patch: { content: 'New draft' } }).node;
    expect(req('update_node', { creationId: 'book', nodeId: 'c2', baseRevId: first.currentRevId, content: 'Stale' })).toEqual({ conflict: true, currentRevId: second.currentRevId, currentContent: 'New draft' });
    const path = join(dir, 'creations', '_creations', 'book', 'artifacts', 'c2', 'revisions', `${first.currentRevId}.snap`);
    expect(readFileSync(path, 'utf8')).toBe('One original sentence');
    const restored = req('restore_revision', { creationId: 'book', nodeId: 'c2', revId: first.currentRevId, baseRevId: second.currentRevId }).node;
    expect(restored.currentRevId).not.toBe(first.currentRevId);
    expect(req('get_node', { creationId: 'book', nodeId: 'c2' })).toMatchObject({ node: { content: 'One original sentence' }, revisions: [{ restoredFromRevId: first.currentRevId }, {}, {}] });
    expect(store.getCreation('book')).toMatchObject({ unitCount: 3, readableUnitCount: 1, wordCount: 3, hasReadableContent: true });
    const md = req('export_creation', { creationId: 'book' }).content;
    expect(md).toContain('## Volume One\n\n### Chapter Two\n\nOne original sentence');
    expect(md).toContain('### Chapter Three\n\nFuture plot');
    expect(JSON.parse(req('export_creation', { creationId: 'book', format: 'json' }).content).nodes[0].children[0].content).toBe('One original sentence');
    expect(req('delete_node', { creationId: 'book', nodeId: 'vol1' }).nodeIds).toEqual(expect.arrayContaining(['vol1', 'c1', 'c2']));
    expect(store.getCreation('book')).toMatchObject({ unitCount: 1, readableUnitCount: 0, wordCount: 0, hasReadableContent: false });
  });

  it.each([['deck', 'slides', 'body'], ['gallery', 'images', 'caption'], ['video', 'scenes', 'storyboard']])('exports %s JSON snapshots and merged Markdown', (kind, field, textField) => {
    req('create_creation', { id: 'media', kind });
    const content = { [field]: [{ title: 'Scene A', [textField]: 'A painting of the sky' }] };
    const node = store.createNode('media', { id: 'scene', content });
    expect(JSON.parse(readFileSync(join(dir, 'creations', '_creations', 'media', 'artifacts', 'scene', 'revisions', `${node.currentRevId}.json`)))).toEqual(content);
    expect(req('export_creation', { creationId: 'media' }).content).toContain('A painting of the sky');
    expect(JSON.parse(req('export_creation', { creationId: 'media', format: 'json' }).content).nodes[0].content).toEqual(content);
  });

  it('parses uploaded and pasted sources, reads exact inclusive bytes and rejects path traversal/symlinks', () => {
    const { sources } = req('create_creation', { id: 'c', textSources: [{ text: 'Pasted lore' }], files: [{ name: 'story.md', mimeType: 'text/markdown', data: b64('Hello comet') }] });
    const id = sources[0].id;
    expect(req('get_source', { creationId: 'c', sourceId: id }).source.parsed).toMatchObject({ kind: 'text', chunks: [{ index: 0, text: 'Hello comet' }] });
    expect(req('add_sources', { creationId: 'c', textSources: ['Another note'] }).creation.sourceCount).toBe(3);
    expect(service.handleMediaRead({ requestId: 'relay', creationId: 'c', mediaKind: 'source', mediaId: id, start: 6, end: 99 })).toMatchObject({
      type: 'creation_media_chunk', ok: true, requestId: 'relay', start: 6, end: 10, totalSize: 11, filename: 'story.md', data: b64('comet'),
    });
    expect(() => store.readMediaRange('c', 'source', id, 11)).toThrow(err('INVALID_RANGE'));
    expect(() => store.readMediaRange('c', 'source', '../secret')).toThrow(err('INVALID_REQUEST'));
    expect(() => store.readMediaRange('../c', 'source', id)).toThrow(err('INVALID_REQUEST'));
    const raw = join(dir, 'creations', '_creations', 'c', 'sources', id, 'original');
    const outside = join(dir, 'secret');
    renameSync(raw, `${raw}.old`);
    writeFileSync(outside, 'hidden');
    symlinkSync(outside, raw);
    expect(() => store.readMediaRange('c', 'source', id)).toThrow(err('INVALID_PATH'));
    req('delete_source', { creationId: 'c', sourceId: id });
    expect(readFileSync(outside, 'utf8')).toBe('hidden');
    expect(store.getCreation('c').sourceCount).toBe(2);
  });

  it('persists verified source MIME and video flags independently of upload names and declarations', () => {
    const { sources } = req('create_creation', { id: 'sources', textSources: ['Notes'], files: [
      { name: 'video.bin', mimeType: 'application/octet-stream', data: b64(Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex')) },
      { name: 'fake.mp4', mimeType: 'video/mp4', data: b64('<!doctype html><html>Not a movie</html>') },
    ] });
    const expected = [
      { name: 'video.bin', mimeType: 'application/octet-stream', kind: 'video', detectedMimeType: 'video/mp4', playableVideo: true },
      { name: 'fake.mp4', detectedMimeType: null, playableVideo: false },
      { name: 'Notes.txt', detectedMimeType: null, playableVideo: false },
    ];
    expect(sources).toMatchObject(expected);
    expect(req('get_creation', { creationId: 'sources' }).sources).toMatchObject(expected);
  });

  it.each([
    ['0000001466747970717420200000000071742020', 'video/mp4'],
    ['000000096d6f6f7600', 'video/mp4'],
    ['000000096d64617400', 'video/mp4'],
    ['000000186674797069736f6d', null], // Truncated ftyp box.
    ['1a45dfa3', null], // Plain EBML / Matroska without WebM DocType.
    ['1a45dfa34282847765626d', 'video/webm'],
    ['89504e470d0a1a0a', 'image/png'],
    ['ffd8ff', 'image/jpeg'],
    ['474946383961', 'image/gif'],
    ['524946460000000057454250', 'image/webp'],
    ['255044462d', 'application/pdf'],
  ])('detects source signature %s as %s', (hex, mimeType) => {
    expect(parseSource(Buffer.from(hex, 'hex')).detectedMimeType).toBe(mimeType);
  });

  it('extracts simple PDF/Flate text, bounds large text, and emits binary metadata', () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      deflateSync('BT (Hello\\040PDF) Tj [(A) 20 <42>] TJ ET'), Buffer.from('\nendstream\nendobj')]);
    expect(parseSource(pdf, { name: 'refs.pdf' })).toMatchObject({ kind: 'pdf', chunks: [{ text: 'Hello PDF\nAB' }] });
    expect(parseSource(Buffer.from([0, 255]), { name: 'clip.mp4' })).toMatchObject({ kind: 'video', byteLength: 2, chunks: [] });
    const text = parseSource(Buffer.from('x'.repeat(130_000)), { name: 'large.csv' });
    expect(text.truncated).toBe(true);
    expect(text.chunks.map(chunk => chunk.text).join('')).toHaveLength(120_000);
  });

  it('keeps stale proposals pending, supports force/explicit locked Canon acceptance, and rejects without changing prose', () => {
    store.createCreation({ id: 'c' });
    const node = store.createNode('c', { id: 'chapter', content: 'Original' });
    const edit = store.proposeUnitEdit('c', node.id, { proposedContent: 'Proposed' });
    const rejected = store.proposeUnitEdit('c', node.id, { proposedContent: 'Reject me' });
    const canon = store.upsertCanon('c', { id: 'lore', lockedByUser: true, title: 'Lore', contentMd: 'Immutable until accepted' });
    const patch = store.proposeCanonPatch('c', { id: canon.id, contentMd: 'Approved later' });
    expect(store.getCreation('c').pendingProposalCount).toBe(3);
    const resolve = (id, action, force = false) => req('resolve_proposal', { creationId: 'c', proposalId: id, action, force });
    expect(resolve(rejected.id, 'reject').proposal.status).toBe('rejected');
    store.updateNode('c', node.id, { content: 'User revised' });
    expect(resolve(edit.id, 'accept')).toMatchObject({ conflict: true, currentContent: 'User revised' });
    expect(resolve(edit.id, 'accept', true)).toMatchObject({ node: { content: 'Proposed' }, proposal: { status: 'accepted' } });
    expect(resolve(patch.id, 'accept')).toMatchObject({ canon: { lockedByUser: true, contentMd: 'Approved later' } });
    expect(req('list_proposals', { creationId: 'c', status: 'pending' }).proposals).toEqual([]);
  });

  it('recovers interrupted leases without replay and preserves progress', () => {
    store.createCreation({ id: 'c' });
    const run = store.createRun('c', { bootId: 'boot-a', type: 'batch', progress: { completed: 1, total: 3 }, currentNodeId: 'b' });
    const second = createCreationStore({ yeaftDir: dir });
    try {
      expect(second.recoverInterruptedRuns('boot-a')).toEqual([]);
      expect(second.recoverInterruptedRuns('boot-b')).toMatchObject([{ id: run.id, status: 'paused', reason: 'agent_restarted', leaseEpoch: 2, currentNodeId: null, progress: { completed: 1 } }]);
      expect(store.updateRun('c', run.id, run, { status: 'completed' })).toBeNull();
      expect(second.recoverInterruptedRuns('boot-b')).toEqual([]);
    } finally { second.close(); }
  });

  it('relays lazy authenticated requests and the Server’s media-pull contract', async () => {
    const sent = [];
    let loaded = 0;
    const bridge = createCreationBridge({ context: { CONFIG: { yeaftDir: dir, serverUrl: 'wss://one.example' }, agentId: 'agent:1' }, send: msg => sent.push(msg),
      createService: options => { loaded++; return createCreationService(options); } });
    try {
      await bridge.request({ type: 'creation_request', requestId: 'unauth', op: 'list_creations' });
      expect(loaded).toBe(0);
      await bridge.request({ type: 'creation_request', ownerId: 'owner', requestId: 'req', op: 'create_creation', payload: { id: 'relay', textSources: [''] } });
      const response = sent.find(msg => msg.requestId === 'req');
      expect(response).toMatchObject({ ok: true, data: { sources: [{ url: expect.stringContaining('/agent%3A1/relay/media/source/') }] } });
      await bridge.mediaRead({ type: 'creation_media_read', ownerId: 'owner', requestId: 'media', creationId: 'relay', mediaKind: 'source', mediaId: response.data.sources[0].id, start: 0, end: 0 });
      expect(sent.at(-1)).toMatchObject({ type: 'creation_media_chunk', requestId: 'media', ok: true, totalSize: 0, end: -1, data: '' });
      expect(sent.filter(msg => msg.type === 'creation_event')).toMatchObject([{ ownerId: 'owner' }]);
      const alias = join(dir, 'alias');
      symlinkSync(dir, alias, 'dir');
      await bridge.request({ type: 'creation_request', ownerId: 'owner', requestId: 'folder', op: 'find_by_folder', payload: { rootDir: alias } });
      expect(sent.at(-1)).toMatchObject({ type: 'creation_response', requestId: 'folder', ok: false,
        errorCode: 'invalid_request', error: expect.stringContaining('symbolic links') });
      expect(loaded).toBe(1);
    } finally { await bridge.close(); }
  });
});

it('binds runtime storage to all three authenticated identity fields and fences media and retired events', async () => {
  const sent = [], runtimes = [], eventGuards = [];
  const context = { CONFIG: { yeaftDir: dir, serverUrl: 'wss://one.example' }, agentId: 'agent:1' };
  const bridge = createCreationBridge({ context, send: (msg, delivery) => {
    sent.push(msg);
    if (delivery) eventGuards.push(delivery.isCurrent);
  }, createService: options => {
    const runtime = createCreationService(options);
    const record = { ownerId: options.namespaceBinding.ownerId, closed: false, emit: options.emitEvent };
    runtimes.push(record);
    return { ...runtime, async close() { await runtime.close(); record.closed = true; } };
  } });
  const request = async (ownerId, op, payload) => {
    await bridge.request({ type: 'creation_request', ownerId, requestId: 'req', op, payload });
    return sent.at(-1);
  };
  const create = owner => request(owner, 'create_creation', { id: 'same', title: owner, textSources: ['scoped'] });
  try {
    store.createCreation({ id: 'standalone' });
    const first = await create('owner');
    expect(first).toMatchObject({ ok: true, data: { creation: { title: 'owner' } } });
    const oldEvent = eventGuards.at(-1);
    expect(oldEvent()).toBe(true);
    const media = { type: 'creation_media_read', requestId: 'chunk', creationId: 'same', mediaKind: 'source', mediaId: first.data.sources[0].id };
    await bridge.mediaRead(media);
    expect(sent.at(-1)).toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(runtimes).toHaveLength(1);
    await bridge.mediaRead({ ...media, ownerId: 'other' });
    expect(sent.at(-1)).toMatchObject({ ok: false, errorCode: 'not_found' });
    expect((await request('other', 'list_creations')).data.creations).toEqual([]);
    expect(oldEvent()).toBe(true);
    expect((await create('other')).ok).toBe(true);
    await bridge.mediaRead({ ...media, ownerId: 'owner' });
    expect(sent.at(-1)).toMatchObject({ ok: true, data: b64('scoped') });
    runtimes[0].emit({ type: 'creation_upserted' });
    expect(sent.at(-1)).toMatchObject({ type: 'creation_event', ownerId: 'owner' });
    expect(sent.filter(msg => msg.type === 'creation_event').some(msg => msg.ownerId === 'other')).toBe(true);

    for (const ownerId of ['third', 'fourth', 'fifth']) await request(ownerId, 'list_creations');
    expect(runtimes.filter(r => r.closed).map(r => r.ownerId)).toEqual(['other']);
    expect(oldEvent()).toBe(true);
    const count = sent.length;
    runtimes[1].emit({ type: 'creation_upserted' });
    expect(sent).toHaveLength(count);
    context.CONFIG.serverUrl = 'wss://two.example';
    expect(oldEvent()).toBe(false);
    expect((await request('other', 'list_creations')).data.creations).toEqual([]);
    expect(runtimes.slice(0, 5).every(r => r.closed)).toBe(true);
    await create('other');
    context.agentId = 'agent:2';
    expect((await request('other', 'list_creations')).data.creations).toEqual([]);
    expect(runtimes[5].closed).toBe(true);
    await bridge.mediaRead({ ...media, ownerId: 'owner' });
    expect(sent.at(-1).ok).toBe(false);
    context.CONFIG.serverUrl = 'wss://one.example';
    context.agentId = 'agent:1';
    expect((await request('owner', 'list_creations')).data.creations).toMatchObject([{ id: 'same', title: 'owner' }]);
    await bridge.mediaRead({ ...media, ownerId: 'owner' });
    expect(sent.at(-1)).toMatchObject({ ok: true, data: b64('scoped') });
    expect(BUFFERABLE_TYPES.has('creation_event')).toBe(false);
    const binding = { serverUrl: context.CONFIG.serverUrl, agentId: context.agentId, ownerId: 'owner' };
    const key = createHash('sha256').update(Object.values(binding).join('\0')).digest('hex').slice(0, 24);
    const marker = join(dir, 'creations', `ns-${key}`, '.namespace.json');
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(binding);
    for (const ownerId of ['other', 'third', 'fourth', 'fifth']) await request(ownerId, 'list_creations');
    writeFileSync(marker, JSON.stringify({ ...binding, ownerId: 'other' }));
    expect(await request('owner', 'list_creations')).toMatchObject({ ok: false, errorCode: 'invalid_path' });
  } finally { await bridge.close(); }
  expect(runtimes.every(r => r.closed)).toBe(true);
});

it('does not evict active turns or batches when the owner cache overflows or serves uncached media', async () => {
  const context = { CONFIG: { yeaftDir: dir, serverUrl: 'wss://one.example' }, agentId: 'agent:1' };
  const sent = [], runtimes = [], signals = [];
  const { promise: finish, resolve: release } = Promise.withResolvers();
  const writer = createCreationBridge({ context, send: msg => sent.push(msg) });
  const bridge = createCreationBridge({ context, send: msg => sent.push(msg), createService: options => {
    const runtime = createCreationService({ ...options, engineFactory: ({ run, signal, toolRegistry }) => {
      signals.push(signal);
      return { async *query() {
        await finish;
        if (run.type === 'batch') await toolRegistry.execute('creation_write_unit', { nodeId: 'unit', content: 'A full draft.' });
        yield { type: 'turn_end', stopReason: 'end_turn', terminal: true };
      } };
    } });
    const record = { runtime, ownerId: options.namespaceBinding.ownerId, closed: false };
    runtimes.push(record);
    return { ...runtime, close() { record.closed = true; return runtime.close(); } };
  } });
  const request = async (target, ownerId, op, payload = {}) => {
    await target.request({ type: 'creation_request', ownerId, requestId: 'req', op, payload });
    expect(sent.at(-1)).toMatchObject({ ok: true });
    return sent.at(-1).data;
  };
  try {
    const { sources } = await request(writer, 'fifth', 'create_creation', { id: 'book', textSources: ['fifth owner'] });
    await writer.close();
    const runIds = [];
    for (let i = 0; i < 4; i++) {
      const ownerId = `owner${i}`;
      await request(bridge, ownerId, 'create_creation', { id: 'book', starterNode: { id: 'unit' } });
      const { run } = i % 2 === 0
        ? await request(bridge, ownerId, 'send_message', { creationId: 'book', text: 'Plan the book' })
        : await request(bridge, ownerId, 'start_batch_run', { creationId: 'book', nodeIds: ['unit'] });
      runIds.push(run.id);
    }
    const mediaRead = { type: 'creation_media_read', ownerId: 'fifth', requestId: 'media', creationId: 'book', mediaKind: 'source', mediaId: sources[0].id };
    await bridge.mediaRead(mediaRead);
    expect(sent.at(-1)).toMatchObject({ ok: true, data: b64('fifth owner'), version: sources[0].createdAt });
    expect(runtimes).toHaveLength(4); // An uncached media read did not start a runner.
    await request(bridge, 'fifth', 'list_creations');
    expect(runtimes).toHaveLength(5);
    expect(signals).toHaveLength(4);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    expect(runtimes.every(record => !record.closed)).toBe(true);
    for (const [i, { runtime }] of runtimes.slice(0, 4).entries()) {
      expect(runtime.store.getRun('book', runIds[i]).status).toBe('running');
    }
    release();
    await Promise.all(runIds.map((id, i) => runtimes[i].runtime.runner.waitForRun(id)));
    for (const [i, { runtime }] of runtimes.slice(0, 4).entries()) {
      expect(runtime.store.getRun('book', runIds[i]).status).toBe('completed');
    }
    await request(bridge, 'fifth', 'list_creations');
    expect(runtimes.filter(record => record.closed).map(record => record.ownerId)).toEqual(['owner0']);
  } finally { release(); await Promise.all([writer.close(), bridge.close()]); }
});

it('compacts large snapshot proposals and returns byte-budgeted, node-filtered full pages', () => {
  store.createCreation({ id: 'book' });
  store.createNode('book', { id: 'chapter' });
  store.createNode('book', { id: 'other' });
  const prose = 'é'.repeat(200 * 1024);
  const proposals = Array.from({ length: 15 }, () => store.proposeUnitEdit('book', 'chapter', { proposedContent: prose }));
  store.proposeUnitEdit('book', 'other', { proposedContent: 'Other chapter' });
  store.proposeCanonPatch('book', { title: 'Canon title', contentMd: 'Canon body' });
  const detail = req('get_creation', { creationId: 'book' });
  expect(detail.proposals).toHaveLength(17);
  expect(detail.proposals[0].patch).toMatchObject({ title: 'Canon title' });
  const compact = detail.proposals.at(-1);
  expect(compact.proposedContent).toBeUndefined();
  expect(Buffer.byteLength(compact.preview)).toBe(2048);
  expect(compact.diffStats.addedLines).toBe(1);
  const params = { creationId: 'book', nodeId: 'chapter' };
  const full = req('get_node', params).pendingProposals;
  expect(full).toHaveLength(3);
  for (const item of full) {
    expect(item.proposedContent).toBe(prose);
    expect(item.contentTruncated).toBeUndefined();
  }
  const page = req('list_proposals', params);
  expect(page).toEqual({ proposals: full, hasMore: true, nextOffset: 3 });
  expect(req('list_proposals', { ...params, offset: page.nextOffset, limit: 1 })).toEqual({
    proposals: [proposals[11]], hasMore: true, nextOffset: 4,
  });
  expect(req('list_proposals', { ...params, offset: 14, limit: 1 })).toEqual({
    proposals: [proposals[0]], hasMore: false, nextOffset: null,
  });
  const escaped = store.proposeUnitEdit('book', 'chapter', { proposedContent: '\x00'.repeat(400 * 1024) });
  const [oversized] = req('get_node', params).pendingProposals;
  expect(oversized).toMatchObject({ id: escaped.id, contentTruncated: true });
  expect(oversized.proposedContent).toBeUndefined();
  expect(req('get_proposal', { creationId: 'book', proposalId: escaped.id }).proposal).toEqual(escaped);
  expect(() => req('get_proposal', { creationId: 'missing', proposalId: escaped.id })).toThrow(err('NOT_FOUND'));
});

it('pages large folder thread histories newest-first without exceeding the byte budget', () => {
  store.createCreation({ id: 'book' });
  store.createNode('book', { id: 'folder', type: 'folder' });
  const thread = store.getThread('book', { scopeType: 'node', scopeId: 'folder' });
  const scope = { threadId: thread.id, scopeType: 'node', scopeId: 'folder' };
  expect(store.getThread('book', scope)).toEqual(thread);
  const text = 'x'.repeat(256 * 1024);
  for (let i = 0; i < 15; i++) store.addMessage('book', thread.id, { id: `msg${i}`, role: 'assistant', text, content: text });
  store.addMessage('book', thread.id, { id: 'escaped', role: 'assistant', text: '\x00'.repeat(256 * 1024), content: '\x00'.repeat(256 * 1024) });
  let params = { creationId: 'book', ...scope };
  const seen = [];
  do {
    const page = req('get_thread', params);
    expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(1.5 * 1024 * 1024);
    expect(page.hasMore).toBe(page.nextBeforeId !== null);
    if (!seen.length) expect(page.messages.at(-1)).toMatchObject({ id: 'escaped', contentTruncated: true });
    seen.unshift(...page.messages.map(m => m.id));
    params = { ...params, beforeId: page.nextBeforeId };
  } while (params.beforeId);
  expect(seen).toEqual([...Array.from({ length: 15 }, (_, i) => `msg${i}`), 'escaped']);
});

it('serves large Markdown and JSON exports as downloadable ranged assets', () => {
  store.createCreation({ id: 'book' });
  for (let i = 0; i < 18; i++) store.createNode('book', { content: 'x'.repeat(480 * 1024) });
  for (const [format, ext, mimeType] of [['markdown', 'md', 'text/markdown'], ['json', 'json', 'application/json']]) {
    const result = req('export_creation', { creationId: 'book', format });
    expect(result).toMatchObject({ format, filename: `book.${ext}`, mimeType, streamed: true, downloadUrl: `/mock/book/asset/${result.assetId}` });
    expect(result.assetId).toBe(`export-${format}`);
    expect(result.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    expect(result.content).toBeUndefined();
    expect(store.readMediaRange('book', 'asset', result.assetId, result.byteLength - 2)).toMatchObject({
      totalSize: result.byteLength, end: result.byteLength - 1, mimeType, filename: result.filename, disposition: 'attachment',
    });
  }
});

it('replaces a streamed export without accumulating assets or files', () => {
  store.createCreation({ id: 'book' });
  const outlineMd = 'x'.repeat(32 * 1024);
  for (let i = 0; i < 100; i++) store.createNode('book', { id: `node${i}`, title: 'Old title', outlineMd });
  const exportAgain = format => req('export_creation', { creationId: 'book', format });
  const first = exportAgain('markdown');
  expect(first.streamed).toBe(true);
  const read = (start = 0) => store.readMediaRange('book', 'asset', first.assetId, start, start + 100);
  const firstChunk = read();
  expect(firstChunk.version).toEqual(expect.any(String));
  expect(firstChunk.bytes.toString()).toContain('Old title');
  const regular = store.saveAsset('book', { ext: 'md', content: 'Separate asset' });
  store.updateNode('book', 'node0', { title: 'New title' });
  expect(() => store.transaction(() => {
    exportAgain('markdown');
    throw new Error('roll back export');
  })).toThrow('roll back export');
  expect(read()).toEqual(firstChunk);
  for (let i = 0; i < 3; i++) expect(exportAgain('md')).toMatchObject({ assetId: first.assetId, byteLength: first.byteLength });
  const nextChunk = read(101);
  expect(nextChunk.totalSize).toBe(firstChunk.totalSize);
  expect(nextChunk.version).not.toBe(firstChunk.version);
  expect(read().version).toBe(nextChunk.version);
  expect(service.handleMediaRead({ requestId: 'relay', creationId: 'book', mediaKind: 'asset', mediaId: first.assetId, start: 101, end: 201 }))
    .toMatchObject({ type: 'creation_media_chunk', version: nextChunk.version, totalSize: firstChunk.totalSize });
  expect(store.listAssets('book').map(asset => asset.id)).toEqual([first.assetId, regular.id]);
  expect(readdirSync(join(dir, 'creations', '_creations', 'book', 'assets')).sort()).toEqual([
    `${first.assetId}.${nextChunk.version}.md`, `${regular.id}.${regular.version}.md`,
  ].sort());
  expect(read().bytes.toString()).toContain('New title');
});

it('reads persisted namespace media after restart without a prior Creation RPC', async () => {
  const context = { CONFIG: { yeaftDir: dir, serverUrl: 'wss://one.example' }, agentId: 'agent:1' };
  const sent = [];
  const open = () => createCreationBridge({ context, send: msg => sent.push(msg) });
  const ownerId = 'owner';
  const writer = open();
  let mediaId;
  try {
    await writer.request({ type: 'creation_request', requestId: 'create', ownerId,
      op: 'create_creation', payload: { id: 'book', textSources: ['persisted'] } });
    mediaId = sent.at(-1).data.sources[0].id;
  } finally { await writer.close(); }
  const reader = open();
  try {
    await reader.mediaRead({ type: 'creation_media_read', ownerId, requestId: 'read', creationId: 'book', mediaKind: 'source', mediaId });
    expect(sent.at(-1)).toMatchObject({ type: 'creation_media_chunk', requestId: 'read', ok: true, data: b64('persisted') });
  } finally { await reader.close(); }
});

it('bounds large creation snapshots without losing the full node or Canon bodies', () => {
  const creationId = 'book';
  store.createCreation({ id: creationId });
  const body = 'x'.repeat(32 * 1024);
  store.transaction(() => {
    for (let i = 0; i < 250; i++) store.createNode(creationId, { id: `node${i}`, outlineMd: body });
    for (let i = 0; i < 500; i++) store.upsertCanon(creationId, { id: `canon${i}`, contentMd: body });
  });
  const detail = req('get_creation', { creationId });
  expect(detail.nodes).toHaveLength(250);
  expect(detail.canon).toHaveLength(500);
  expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(5 * 1024 * 1024);
  expect(detail.nodes[0]).toMatchObject({ outlineMd: body.slice(0, 512), outlineTruncated: true });
  expect(detail.canon[0]).toMatchObject({ contentMd: body.slice(0, 512), contentTruncated: true });
  expect(req('get_node', { creationId, nodeId: 'node0' }).node.outlineMd).toBe(body);
  expect(req('get_canon', { creationId, canonId: 'canon0' }).canon.contentMd).toBe(body);
  expect(() => req('get_canon', { creationId, canonId: 'missing' })).toThrow(err('NOT_FOUND'));
});

it('returns canonical node fields after mutations, including emitted node events', async () => {
  await service.close();
  const events = [];
  service = createCreationService({ yeaftDir: dir, emitEvent: event => events.push(event) });
  store = service.store;
  req('create_creation', { id: 'book' });
  const assertNode = (node, isFolder) => expect(node).toMatchObject({ sortOrder: node.position, isFolder });
  assertNode(store.createNode('book', { id: 'folder', type: 'folder' }), true);
  assertNode(store.updateNode('book', 'folder', { title: 'Revised' }), true);
  assertNode(req('create_node', { creationId: 'book', id: 'unit' }).node, false);
  assertNode(req('update_node', { creationId: 'book', nodeId: 'unit', content: 'Prose' }).node, false);
  const nodeEvents = events.filter(event => ['node_upserted', 'node_content_updated'].includes(event.type));
  expect(nodeEvents.map(event => event.type)).toEqual(['node_upserted', 'node_content_updated']);
  for (const { node } of nodeEvents) assertNode(node, false);
  const [unit, folder] = store.reorderNodes('book', null, ['unit', 'folder']);
  assertNode(unit, false);
  assertNode(folder, true);
  expect(store.getNode('book', 'folder').sortOrder).toBe(1);
  expect(store.listNodes('book').map(node => node.sortOrder)).toEqual([0, 1]);
});

it('deduplicates imports across restarts without replaying sources, starter nodes, or planning', async () => {
  const importKey = 'upload:original';
  expect(() => req('create_creation', { importKey, starterNode: { parentId: 'missing' } })).toThrow(err('NOT_FOUND'));
  const first = req('create_creation', { importKey, starterNode: true, textSources: ['note'] });
  await service.close();
  const events = [];
  service = createCreationService({ yeaftDir: dir, emitEvent: event => events.push(event) });
  const retry = req('create_creation', { importKey, id: 'new-id', prompt: 'Do not plan again', textSources: ['duplicate'] });
  expect(retry).toEqual({ ...req('get_creation', { creationId: first.creation.id }), deduplicated: true });
  expect(retry.sources.map(source => source.id)).toEqual(first.sources.map(source => source.id));
  expect(retry.nodes).toHaveLength(1);
  expect(retry.runs).toEqual([]);
  expect(events).toEqual([]);
  expect(req('list_creations').creations).toHaveLength(1);
  expect(() => req('create_creation', { importKey: 'x'.repeat(129) })).toThrow(err('INVALID_REQUEST'));
});

it('keeps only the latest 50 revision metadata entries on reads and mutations', () => {
  store.createCreation({ id: 'book' });
  const initial = store.createNode('book', { id: 'chapter', content: 'Original' });
  const scope = { creationId: 'book', nodeId: initial.id };
  for (let i = 0; i < 55; i++) store.updateNode('book', initial.id, { content: `Revision ${i}` });
  const update = req('update_node', { ...scope, content: 'Updated' });
  expect(update.revisions).toHaveLength(50);
  expect(update.revisions[0]).toMatchObject({ id: update.node.currentRevId });
  expect(update.revisions[0].content).toBeUndefined();
  expect(req('get_node', scope).revisions).toEqual(update.revisions);
  expect(req('restore_revision', { ...scope, revId: initial.currentRevId }).revisions).toHaveLength(50);
  const proposal = store.proposeUnitEdit('book', initial.id, { proposedContent: 'Accepted' });
  expect(req('resolve_proposal', { ...scope, proposalId: proposal.id, action: 'accept' }).revisions).toHaveLength(50);
});

it('fails interrupted thread runs on service boot and persists one terminal assistant message', async () => {
  store.createCreation({ id: 'book' });
  const thread = store.getThread('book');
  const run = store.createRun('book', { type: 'thread', threadId: thread.id, assistantMessageId: 'assistant', bootId: 'boot-a' });
  await service.close();
  service = createCreationService({ yeaftDir: dir, bootId: 'boot-b' });
  expect(service.store.getRun('book', run.id)).toMatchObject({ status: 'failed', reason: 'agent_restarted' });
  expect(service.store.recoverInterruptedRuns('boot-c')).toEqual([]);
  expect(req('get_thread', { creationId: 'book', threadId: thread.id }).messages).toMatchObject([{
    id: 'assistant', role: 'assistant', status: 'failed', runId: run.id,
    text: 'Turn interrupted by Agent restart.', content: 'Turn interrupted by Agent restart.',
  }]);
});

it('bounds PDF scanning on malformed input and ignores bytes beyond 2 MiB', () => {
  const prefix = Buffer.from('%PDF-1.4\nBT [(escaped\\) literal) <');
  const input = Buffer.concat([prefix, Buffer.alloc(12 * 1024 * 1024, 'a'), Buffer.from('> ] TJ ET\nBT (outside) Tj ET')]);
  const start = performance.now();
  const parsed = parseSource(input, { name: 'huge.pdf' });
  expect(performance.now() - start).toBeLessThan(500); // CI scheduling margin around the parser's 250ms budget.
  expect(parsed).toMatchObject({ kind: 'pdf', truncated: true, chunks: [] });
});

it('rejects plain Matroska EBML without WebM DocType as non-playable video and checks expectedVersion before range bounds', () => {
  store.createCreation({ id: 'book' });
  const mkv = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('matroska\0\0\0\0')]);
  const webm = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('4282847765626d', 'hex'), Buffer.alloc(16)]);
  const [mkvSrc, webmSrc] = store.addSources('book', {
    files: [
      { name: 'clip.mkv', mimeType: 'video/x-matroska', data: mkv.toString('base64') },
      { name: 'clip.webm', mimeType: 'application/octet-stream', data: webm.toString('base64') },
    ],
  });
  expect(mkvSrc.detectedMimeType).toBeNull();
  expect(mkvSrc.playableVideo).toBe(false);
  expect(webmSrc.detectedMimeType).toBe('video/webm');
  expect(webmSrc.playableVideo).toBe(true);

  const asset = store.saveAsset('book', { id: 'export-markdown', ext: 'md', bytes: Buffer.from('short') });
  expect(() => store.readMediaRange('book', 'asset', asset.id, 9999, 10050, { expectedVersion: 'stale-version' }))
    .toThrow(err('CONFLICT'));
});

describe('Creation-scoped Workbench files', () => {
  const owner = 'owner-a';
  const creationId = 'files';
  let root;
  let outside;
  let bridge;
  let savedContext;
  let replies;
  let msg;

  beforeEach(async () => {
    const base = realpathSync(dir);
    root = join(base, 'workspace');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'docs', 'note.txt'), 'inside');
    writeFileSync(join(root, 'clip.mp4'), 'video');
    writeFileSync(join(outside, 'note.txt'), 'outside');
    symlinkSync(outside, join(root, 'external'), 'dir');
    symlinkSync(join(root, 'docs'), join(root, 'internal'), 'dir');
    symlinkSync(join(root, 'docs', 'note.txt'), join(root, 'linked.txt'), 'file');
    symlinkSync(join(root, 'missing'), join(root, 'dangling'), 'file');
    savedContext = Object.fromEntries(['CONFIG', 'agentId', 'creationBridge', 'sendToServer'].map(key => [key, ctx[key]]));
    replies = [];
    Object.assign(ctx, {
      CONFIG: { yeaftDir: dir, serverUrl: 'wss://workbench.example', workDir: outside },
      agentId: 'workbench-agent', sendToServer: async reply => { replies.push(reply); return 'sent'; },
    });
    bridge = createCreationBridge({ send: reply => replies.push(reply) });
    await bridge.request({ type: 'creation_request', ownerId: owner, requestId: 'setup', op: 'create_creation', payload: { id: creationId, rootDir: root } });
    expect(replies.pop()).toMatchObject({ ok: true });
    msg = { creationId, _requestUserId: owner, workDir: outside, rootDir: outside };
  });

  afterEach(async () => {
    try { await bridge?.close(); }
    finally { Object.assign(ctx, savedContext); }
  });

  async function invoke(handler, args = {}, request = msg) {
    await handler({ ...request, ...args });
    return replies.pop();
  }

  it('resolves only the authenticated namespace, even without a live runtime', async () => {
    expect(ctx.creationBridge).toBe(bridge);
    expect(await resolveCreationWorkspaceRoot(owner, creationId)).toBe(root);
    await bridge.close();
    expect(await resolveCreationWorkspaceRoot(owner, creationId)).toBeNull();
    bridge = createCreationBridge();
    expect(await resolveCreationWorkspaceRoot(owner, creationId)).toBe(root);
    expect(await resolveCreationWorkspaceRoot('owner-b', creationId)).toBeNull();
    expect(await resolveCreationWorkspaceRoot(owner, 'missing')).toBeNull();
    expect(await resolveCreationWorkspaceRoot(owner, '../bad')).toBeNull();
  });

  it('checks traversal, absolute paths, every symlink segment, and the registered root', async () => {
    expect(await resolveWorkItemPath({ ...msg, creationId: ` ${creationId} `, workbenchRoute: { runtimeProvider: 'work-center' } },
      'docs/note.txt', outside)).toBe(join(root, 'docs', 'note.txt'));
    expect(await resolveWorkItemPath(msg, 'docs/new/deep.txt', outside)).toBe(join(root, 'docs', 'new', 'deep.txt'));
    for (const path of ['../outside/note.txt', join(outside, 'note.txt'), 'external/note.txt', 'internal/new.txt', 'linked.txt', 'dangling']) {
      await expect(resolveWorkItemPath(msg, path, outside)).rejects.toMatchObject(err('FILE_OUTSIDE_WORKSPACE'));
    }
    for (const fakeRoot of ['relative', join(root, 'linked.txt'), join(root, 'internal'), join(root, 'missing')]) {
      await expect(resolveWorkItemPath(msg, '.', outside, { resolveCreationWorkspaceRoot: async () => fakeRoot }))
        .rejects.toMatchObject(err('FILE_OUTSIDE_WORKSPACE'));
    }
  });

  it('lists the recorded root by default, filters links, and reports listing metadata', async () => {
    const ordinary = await invoke(handleListDirectory, { dirPath: root }, {});
    expect(ordinary.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'docs', isSymlink: false, mtimeMs: statSync(join(root, 'docs')).mtimeMs }),
      expect.objectContaining({ name: 'external', isSymlink: true, mtimeMs: statSync(outside).mtimeMs }),
      expect.objectContaining({ name: 'dangling', isSymlink: true, mtimeMs: 0 }),
    ]));
    const scoped = await invoke(handleListDirectory);
    expect(scoped.dirPath).toBe(root);
    expect(scoped.entries.map(entry => entry.name)).toEqual(['docs', 'clip.mp4']);
    for (const entry of scoped.entries) {
      expect(entry.isSymlink).toBe(false);
      expect(entry.mtimeMs).toBeGreaterThan(0);
    }
  });

  it('advertises scoped I/O only when the required platform primitives exist', () => {
    expect(supportsCreationWorkbenchFiles()).toBe(Boolean(constants.O_NOFOLLOW) && process.platform === 'linux' && existsSync('/proc/self/fd'));
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { expect(supportsCreationWorkbenchFiles()).toBe(false); }
    finally { Object.defineProperty(process, 'platform', { value: platform }); }
  });

  it.each([true, false])('cleans up a new entry after its pinned parent moves outside the root (directory=%s)', async isDirectory => {
    const relocated = join(outside, 'relocated');
    const operation = isDirectory ? mkdir : open;
    const real = operation.getMockImplementation();
    const filePath = 'docs/new';
    let moved = false;
    operation.mockImplementation(async (path, ...args) => {
      if (!moved && path.startsWith('/proc/self/fd/') && path.endsWith('/new')) {
        moved = true;
        renameSync(join(root, 'docs'), relocated);
      }
      return real(path, ...args);
    });
    try {
      const response = isDirectory ? await invoke(handleCreateFile, { filePath, isDirectory })
        : await invoke(handleWriteFile, { filePath, content: 'must not escape' });
      expect(response).toMatchObject({ success: false, errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(moved).toBe(true);
      expect(readdirSync(relocated)).toEqual(['note.txt']);
      expect(readFileSync(join(relocated, 'note.txt'), 'utf8')).toBe('inside');
    } finally { operation.mockImplementation(real); }
  });

  it('uses kernel no-replace for raced file targets and fails closed on directory moves', async () => {
    const real = link.getMockImplementation();
    const source = join(root, 'docs', 'note.txt');
    const target = join(root, 'target.txt');
    let raced = false;
    link.mockImplementation(async (src, dest) => {
      raced = true;
      writeFileSync(target, 'racer', { flag: 'wx' });
      return real(src, dest);
    });
    try {
      await expect(withCreationFiles(msg, files => files.move(source, target))).rejects.toMatchObject(err('EEXIST'));
      expect(raced).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('racer');
      expect(readFileSync(source, 'utf8')).toBe('inside');
      await expect(withCreationFiles(msg, files => files.move(join(root, 'docs'), join(root, 'moved')))).rejects.toMatchObject({
        code: 'FILE_OUTSIDE_WORKSPACE', message: 'Creation-scoped directory move requires atomic no-replace support.',
      });
      expect(existsSync(join(root, 'moved'))).toBe(false);
      expect(readFileSync(source, 'utf8')).toBe('inside');
    } finally { link.mockImplementation(real); }
  });

  it.each(['source', 'target'])('rolls back the destination link when the %s parent moves during publication', async side => {
    const real = link.getMockImplementation();
    const source = join(root, 'docs', 'note.txt');
    const targetDir = join(root, 'destination');
    const relocated = join(outside, 'relocated');
    mkdirSync(targetDir);
    link.mockImplementation(async (src, dest) => {
      await real(src, dest);
      renameSync(side === 'source' ? dirname(source) : targetDir, relocated);
    });
    try {
      await expect(withCreationFiles(msg, files => files.move(source, join(targetDir, 'note.txt'))))
        .rejects.toMatchObject(err('FILE_OUTSIDE_WORKSPACE'));
      expect(readFileSync(side === 'source' ? join(relocated, 'note.txt') : source, 'utf8')).toBe('inside');
      expect(readdirSync(side === 'source' ? targetDir : relocated)).toEqual([]);
    } finally { link.mockImplementation(real); }
  });

  it('rolls back a linked destination when source unlink is denied and allows a clean retry', async () => {
    const source = join(root, 'docs', 'note.txt');
    const target = join(root, 'moved.txt');
    const originalUnlink = unlink.getMockImplementation();
    const privileged = process.getuid?.() === 0;
    if (privileged) {
      // Root can unlink despite chmod; keep the real link and rollback calls.
      unlink.mockImplementation(async path => {
        if (path.endsWith('/note.txt')) {
          expect(statSync(target).ino).toBe(statSync(source).ino);
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return originalUnlink(path);
      });
    } else chmodSync(dirname(source), 0o555);
    try {
      await expect(withCreationFiles(msg, files => files.move(source, target))).rejects.toMatchObject(err('EACCES'));
      expect(existsSync(target)).toBe(false);
      expect(statSync(source).nlink).toBe(1);
    } finally {
      if (privileged) unlink.mockImplementation(originalUnlink);
      else chmodSync(dirname(source), 0o755);
    }
    await withCreationFiles(msg, files => files.move(source, target));
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('inside');
  });

  it('preserves a replacement destination when source unlink fails', async () => {
    const source = join(root, 'docs', 'note.txt');
    const target = join(root, 'moved.txt');
    const originalUnlink = unlink.getMockImplementation();
    unlink.mockImplementation(async path => {
      if (path.endsWith('/note.txt')) {
        expect(statSync(target).ino).toBe(statSync(source).ino);
        rmSync(target);
        writeFileSync(target, 'replacement');
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return originalUnlink(path);
    });
    try {
      await expect(withCreationFiles(msg, files => files.move(source, target))).rejects.toMatchObject(err('EACCES'));
      expect(readFileSync(target, 'utf8')).toBe('replacement');
      expect(readFileSync(source, 'utf8')).toBe('inside');
    } finally { unlink.mockImplementation(originalUnlink); }
  });

  it.each([{ content: null }, {}])('rejects invalid write content before resolving scope or opening a file (%j)', async args => {
    const resolveRoot = vi.spyOn(bridge, 'resolveWorkspaceRoot');
    try {
      const filePath = 'docs/note.txt';
      expect(await invoke(handleWriteFile, { filePath, ...args })).toMatchObject({ type: 'file_saved', success: false,
        errorCode: 'INVALID_CONTENT', error: 'File content must be a string.' });
      expect(resolveRoot).not.toHaveBeenCalled();
      expect(readFileSync(join(root, filePath), 'utf8')).toBe('inside');
      expect(await invoke(handleWriteFile, { filePath: join(outside, 'note.txt'), ...args }, {}))
        .toMatchObject({ success: false, errorCode: 'INVALID_CONTENT' });
      expect(readFileSync(join(outside, 'note.txt'), 'utf8')).toBe('outside');
    } finally { resolveRoot.mockRestore(); }
  });

  it('checks the actual target for binary bytes and checks both write preconditions without truncating', async () => {
    const filePath = 'docs/note.txt';
    const absolute = join(root, filePath);
    const before = await invoke(handleReadFile, { filePath });
    expect(before).toMatchObject({ content: 'inside', size: 6, mtimeMs: statSync(absolute).mtimeMs });
    const binary = Buffer.from([0x41, 0, 0x42]);
    renameSync(absolute, `${absolute}.original`);
    writeFileSync(absolute, binary);
    const write = { filePath, content: 'é', requireTextTarget: true };
    expect(await invoke(handleWriteFile, write)).toMatchObject({ success: false, errorCode: 'FILE_IS_BINARY' });
    expect(readFileSync(absolute)).toEqual(binary);
    writeFileSync(absolute, 'new copy');
    const { size, mtimeMs } = statSync(absolute);
    for (const conditions of [{ expectedSize: before.size, expectedMtimeMs: mtimeMs }, { expectedSize: size, expectedMtimeMs: mtimeMs - 1000 }]) {
      expect(await invoke(handleWriteFile, { ...write, ...conditions })).toMatchObject({ success: false, errorCode: 'FILE_CONFLICT' });
      expect(readFileSync(absolute, 'utf8')).toBe('new copy');
    }
    const saved = await invoke(handleWriteFile, { ...write, expectedSize: size, expectedMtimeMs: mtimeMs });
    expect(saved).toMatchObject({ success: true, size: 2, mtimeMs: statSync(absolute).mtimeMs });
    expect(readFileSync(absolute, 'utf8')).toBe('é');
  });

  it.each([
    ['invalid UTF-8 with no NUL', Buffer.from([0x41, 0xff, 0x42])],
    ['NUL at 16 KiB', Buffer.concat([Buffer.alloc(16 * 1024, 0x41), Buffer.from([0])])],
    ['incomplete final UTF-8 sequence', Buffer.concat([Buffer.alloc(64 * 1024, 0x41), Buffer.from([0xe2, 0x82])])],
  ])('rejects a text save on %s without truncating', async (_, bytes) => {
    const filePath = 'docs/note.txt';
    const target = join(root, filePath);
    writeFileSync(target, bytes);
    expect(await invoke(handleWriteFile, { filePath, content: 'replacement', requireTextTarget: true }))
      .toMatchObject({ success: false, errorCode: 'FILE_IS_BINARY', error: 'Cannot overwrite a binary file from text Canvas.' });
    expect(readFileSync(target)).toEqual(bytes);
  });

  it('accepts a UTF-8 character split across the 64 KiB scan boundary', async () => {
    const filePath = 'docs/note.txt';
    const target = join(root, filePath);
    writeFileSync(target, `${'a'.repeat(64 * 1024 - 1)}€`);
    expect(await invoke(handleWriteFile, { filePath, content: 'saved', requireTextTarget: true })).toMatchObject({ success: true });
    expect(readFileSync(target, 'utf8')).toBe('saved');
  });

  it.each(['expectedSize', 'expectedMtimeMs'])('does not recreate a loaded file deleted before saving with %s', async key => {
    const filePath = 'docs/note.txt';
    const target = join(root, filePath);
    const { size, mtimeMs } = await invoke(handleReadFile, { filePath });
    rmSync(target);
    expect(await invoke(handleWriteFile, { filePath, content: 'saved', requireTextTarget: true, [key]: key === 'expectedSize' ? size : mtimeMs }))
      .toMatchObject({ success: false, errorCode: 'FILE_CONFLICT', error: 'File no longer exists on disk.' });
    expect(existsSync(target)).toBe(false);
  });

  it('reads, writes, creates, uploads and streams video inside the recorded root', async () => {
    expect(await invoke(handleReadFile, { filePath: 'docs/note.txt', workspaceBoundPreview: true })).toMatchObject({ content: 'inside' });
    expect(await invoke(handleWriteFile, { filePath: 'docs/new.txt', content: 'write' })).toMatchObject({ success: true });
    expect(await invoke(handleCreateFile, { filePath: 'nested/new.txt' })).toMatchObject({ success: true });
    expect(await invoke(handleUploadToDir, { dirPath: 'uploads/new', files: [{ name: 'upload.txt', data: b64('uploaded') }] }))
      .toMatchObject({ success: true, uploadedCount: 1 });
    expect(readFileSync(join(root, 'docs', 'new.txt'), 'utf8')).toBe('write');
    expect(readFileSync(join(root, 'nested', 'new.txt'), 'utf8')).toBe('');
    expect(readFileSync(join(root, 'uploads', 'new', 'upload.txt'), 'utf8')).toBe('uploaded');
    const video = await invoke(handleVideoMetadata, { filePath: 'clip.mp4' });
    expect(video).toMatchObject({ size: 5, mimeType: 'video/mp4' });
    expect(await invoke(handleVideoChunk, { filePath: video.filePath, start: 0, end: 4, expectedSize: video.size, expectedMtimeMs: video.mtimeMs }))
      .toMatchObject({ content: b64('video') });
  });

  it('rejects escaping paths and both internal and external symlinks across handlers', async () => {
    for (const path of ['../outside', outside, 'external', 'internal']) {
      expect(await invoke(handleListDirectory, { dirPath: path })).toMatchObject({ entries: [], errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(await invoke(handleReadFile, { filePath: `${path}/note.txt` })).toMatchObject({ errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(await invoke(handleWriteFile, { filePath: `${path}/note.txt`, content: 'overwrite' })).toMatchObject({ success: false, errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(await invoke(handleCreateFile, { filePath: `${path}/new.txt` })).toMatchObject({ success: false, errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(await invoke(handleUploadToDir, { dirPath: path, files: [{ name: 'new.txt', data: b64('upload') }] }))
        .toMatchObject({ success: false, errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(await invoke(handleVideoMetadata, { filePath: `${path}/clip.mp4` })).toMatchObject({ errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(await invoke(handleVideoChunk, { filePath: `${path}/clip.mp4` })).toMatchObject({ errorCode: 'FILE_OUTSIDE_WORKSPACE' });
    }
    expect(await invoke(handleReadFile, { filePath: join(outside, 'note.txt'), responseImagePreview: true })).toMatchObject({ errorCode: 'FILE_OUTSIDE_WORKSPACE' });
    expect(await invoke(handleUploadToDir, { files: ['linked.txt', 'dangling', '../outside/note.txt'].map(name => ({ name, data: b64('overwrite') })) }))
      .toMatchObject({ success: false, errorCount: 3 });
    expect(readFileSync(join(root, 'docs', 'note.txt'), 'utf8')).toBe('inside');
    expect(readdirSync(join(root, 'docs'))).toEqual(['note.txt']);
    expect(readFileSync(join(outside, 'note.txt'), 'utf8')).toBe('outside');
    expect(readdirSync(outside)).toEqual(['note.txt']);
  });

  it('revalidates persisted private roots in both the live and read-only bridge', async () => {
    const namespaceKey = createHash('sha256').update(`wss://workbench.example\0workbench-agent\0${owner}`).digest('hex').slice(0, 24);
    const writer = createCreationStore({ yeaftDir: dir, namespaceKey,
      namespaceBinding: { ownerId: owner, serverUrl: 'wss://workbench.example', agentId: 'workbench-agent' } });
    try {
      const sibling = join(writer.creationsRoot, 'ns-sibling');
      const sameNamespaceWrongId = join(writer.root, '_workspaces', 'another');
      mkdirSync(sibling);
      mkdirSync(sameNamespaceWrongId, { recursive: true });
      const invalid = [sibling, writer.creationsRoot, realpathSync(dir), dirname(realpathSync(dir)), sameNamespaceWrongId];
      for (const rootDir of invalid) {
        writer.run("UPDATE creations SET data=json_set(data,'$.rootDir',?) WHERE id=?", rootDir, creationId);
        expect(await resolveCreationWorkspaceRoot(owner, creationId)).toBeNull();
      }
      await bridge.close();
      bridge = createCreationBridge();
      for (const rootDir of invalid) {
        writer.run("UPDATE creations SET data=json_set(data,'$.rootDir',?) WHERE id=?", rootDir, creationId);
        expect(await resolveCreationWorkspaceRoot(owner, creationId)).toBeNull();
      }
      const legacy = join(writer.root, 'workspaces', creationId);
      mkdirSync(legacy, { recursive: true });
      writer.run("UPDATE creations SET data=json_set(data,'$.rootDir',?) WHERE id=?", legacy, creationId);
      expect(await resolveCreationWorkspaceRoot(owner, creationId)).toBe(legacy);
    } finally { writer.close(); }
  });

  it('rejects destructive operations on the bound root and symlinks but allows strict children', async () => {
    for (const path of ['.', root]) {
      await expect(resolveWorkItemPath(msg, path, outside, { strictDescendant: true })).rejects.toMatchObject(err('FILE_OUTSIDE_WORKSPACE'));
      expect(await invoke(handleDeleteFiles, { paths: [path] })).toMatchObject({ success: false, deletedCount: 0 });
      expect(await invoke(handleMoveFiles, { paths: [path], destination: 'move-here' })).toMatchObject({ success: false, movedCount: 0 });
      expect(await invoke(handleCopyFiles, { paths: [path], destination: '.' })).toMatchObject({ success: false, copiedCount: 0 });
    }
    expect(readdirSync(root)).not.toContain('move-here');
    expect(readFileSync(join(root, 'docs', 'note.txt'), 'utf8')).toBe('inside');
    symlinkSync(outside, join(root, 'docs', 'nested-link'), 'dir');
    for (const path of ['linked.txt', 'external/note.txt', 'docs']) {
      expect(await invoke(handleDeleteFiles, { paths: [path] })).toMatchObject({ success: false });
      expect(await invoke(handleMoveFiles, { paths: [path], destination: 'moved' })).toMatchObject({ success: false });
      expect(await invoke(handleCopyFiles, { paths: [path], destination: 'copied' })).toMatchObject({ success: false });
    }
    expect(await invoke(handleCopyFiles, { paths: ['docs/note.txt'], destination: 'copied' })).toMatchObject({ success: true });
    expect(await invoke(handleMoveFiles, { paths: ['copied/note.txt'], destination: 'moved' })).toMatchObject({ success: true });
    expect(readFileSync(join(root, 'moved', 'note.txt'), 'utf8')).toBe('inside');
    expect(await invoke(handleDeleteFiles, { paths: ['docs/note.txt'] })).toMatchObject({ success: true, deletedCount: 1 });
    expect(existsSync(join(root, 'docs', 'note.txt'))).toBe(false);
    expect(statSync(root).isDirectory()).toBe(true);
  });

  it('keeps read metadata and bytes on the same descriptor if the pathname changes', async () => {
    const path = join(root, 'docs', 'note.txt');
    const handle = await open(path, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const read = prototype.read;
    let replaced = false;
    const spy = vi.spyOn(prototype, 'read').mockImplementation(async function (...args) {
      if (!replaced && realpathSync(`/proc/self/fd/${this.fd}`) === path) {
        replaced = true;
        renameSync(path, join(root, 'docs', 'original.txt'));
        writeFileSync(path, 'replacement');
      }
      return read.apply(this, args);
    });
    try {
      expect(await invoke(handleReadFile, { filePath: path })).toMatchObject({ content: 'inside' });
      expect(replaced).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('replacement');
    } finally { spy.mockRestore(); }
  });

  it('closes pinned descriptors on success and rejection, and rejects leaf links and non-regular files', async () => {
    const procFds = '/proc/self/fd';
    const openWorkspaceFds = () => readdirSync(procFds).flatMap(fd => {
      try { return realpathSync(join(procFds, fd)).startsWith(root) ? [fd] : []; } catch { return []; }
    });
    symlinkSync(join(root, 'clip.mp4'), join(root, 'linked.mp4'));
    mkdirSync(join(root, 'directory.mp4'));
    for (const filePath of ['linked.mp4', 'directory.mp4']) {
      expect(await invoke(handleVideoMetadata, { filePath })).toMatchObject({ errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(await invoke(handleVideoChunk, { filePath })).toMatchObject({ errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      expect(await invoke(handleWriteFile, { filePath, content: 'overwrite' })).toMatchObject({ success: false });
      expect(await invoke(handleReadFile, { filePath })).toMatchObject({ errorCode: 'FILE_OUTSIDE_WORKSPACE' });
    }
    expect(await invoke(handleCreateFile, { filePath: 'linked.txt' })).toMatchObject({ success: false });
    expect(await invoke(handleWriteFile, { filePath: 'docs/note.txt', content: 'new' })).toMatchObject({ success: true });
    expect(await invoke(handleReadFile, { filePath: 'docs/note.txt' })).toMatchObject({ content: 'new' });
    expect(await invoke(handleVideoMetadata, { filePath: 'clip.mp4' })).toMatchObject({ size: 5 });
    expect(await invoke(handleVideoChunk, { filePath: 'clip.mp4', start: 10, end: 11 })).toMatchObject({ errorCode: 'VIDEO_RANGE_INVALID' });
    expect(openWorkspaceFds()).toEqual([]);
  });

  it('fails closed for missing or unowned creations and absent authenticated ownership', async () => {
    for (const args of [{ creationId: 'missing' }, { creationId: '' }, { _requestUserId: 'owner-b' }, { _requestUserId: undefined }]) {
      await expect(resolveWorkItemPath({ ...msg, ...args }, '.', outside)).rejects.toMatchObject(err('FILE_OUTSIDE_WORKSPACE'));
      for (const [handler, payload] of [
        [handleListDirectory, {}], [handleReadFile, { filePath: 'docs/note.txt' }],
        [handleWriteFile, { filePath: 'docs/note.txt', content: 'overwrite' }], [handleCreateFile, { filePath: 'new.txt' }],
        [handleUploadToDir, { files: [{ name: 'new.txt', data: b64('upload') }] }],
      ]) {
        expect(await invoke(handler, { ...args, ...payload })).toMatchObject({ errorCode: 'FILE_OUTSIDE_WORKSPACE' });
      }
    }
  });
});
