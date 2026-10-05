import { createHash, randomUUID } from 'node:crypto';
import { constants, fstatSync, lstatSync, openSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Project } from '../shared/rules.ts';
import { rootIdentity, within } from './importer.ts';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_RECORDS = 200;
const MAX_RECORD_BYTES = 1_500;

export interface MemoryRecord { id: string; text: string; author: string; createdAt: number; approved: boolean }
interface MemoryFile { version: 2; projectId: string; projectRoot: string; projectIdentity: string; records: MemoryRecord[] }

function validateRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<MemoryRecord>;
  return typeof record.id === 'string' && /^[a-f0-9-]{36}$/iu.test(record.id)
    && typeof record.text === 'string' && Buffer.byteLength(record.text, 'utf8') <= MAX_RECORD_BYTES
    && typeof record.author === 'string' && record.author.length <= 80
    && Number.isSafeInteger(record.createdAt) && typeof record.approved === 'boolean';
}

/** The approved memory store is in plugin-owned data, outside the agent-writable project. */
export class ProjectMemoryStore {
  private readonly root: string;
  private readonly identity: string;
  private readonly projectId: string;
  private readonly directory: string;
  private readonly file: string;
  private readonly legacyFile: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(project: Project, dataDir: string) {
    this.root = realpathSync(project.root);
    this.identity = project.rootIdentity;
    this.projectId = project.id;
    if (this.root !== project.root || rootIdentity(this.root) !== this.identity) throw new Error('The registered project root changed; add it again.');
    this.directory = join(realpathSync(resolve(dataDir)), 'memory');
    const name = createHash('sha256').update(`${this.projectId}\0${this.root}\0${this.identity}`).digest('hex');
    this.file = join(this.directory, `${name}.json`);
    this.legacyFile = join(this.root, '.canvastty', 'memory.json');
  }

  async read(): Promise<MemoryRecord[]> {
    await this.checkDirectory(true);
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('Project memory must be a private regular file under 256 KiB.');
      const raw = readFileSync(fd, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Project memory file is invalid.');
      const value = parsed as Partial<MemoryFile>;
      if (value.version !== 2 || value.projectId !== this.projectId || value.projectRoot !== this.root || value.projectIdentity !== this.identity
        || !Array.isArray(value.records) || value.records.length > MAX_RECORDS || value.records.some(record => !validateRecord(record))) {
        throw new Error('Project memory file is invalid or belongs to a different folder.');
      }
      return structuredClone(value.records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The v1 project file was writable by agents, so every imported record becomes a proposal regardless of its
        // saved `approved` flag. Write an empty store too when there was no legacy file, preventing later re-import.
        const records = this.readLegacyPending();
        await this.write(records);
        return structuredClone(records);
      }
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('Project memory cannot be a symbolic link.');
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  save(records: MemoryRecord[]): Promise<void> {
    const operation = this.writes.catch(() => undefined).then(async () => {
      if (records.length > MAX_RECORDS || records.some(record => !validateRecord(record))) throw new Error('Project memory is too large or invalid.');
      await this.write(records);
    });
    this.writes = operation;
    return operation;
  }

  private async checkDirectory(create: boolean): Promise<void> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    });
    let info;
    try { info = await lstat(this.directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create) return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new Error('The plugin memory folder must be a real folder owned by this user.');
    if (info.mode & 0o077) await chmod(this.directory, 0o700);
    const real = realpathSync(this.directory);
    if (within(this.root, real) || real !== this.directory) throw new Error('The plugin memory folder must be private and outside the registered project.');
    const rootNow = realpathSync(this.root);
    if (rootNow !== this.root || rootIdentity(rootNow) !== this.identity) throw new Error('The registered project root changed; add it again.');
  }

  private readLegacyPending(): MemoryRecord[] {
    let fd: number | undefined;
    try {
      const directory = join(this.root, '.canvastty');
      const folder = lstatSync(directory);
      if (!folder.isDirectory() || folder.isSymbolicLink() || process.getuid && folder.uid !== process.getuid() || realpathSync(directory) !== directory) return [];
      fd = openSync(this.legacyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== folder.dev || stat.uid !== folder.uid || stat.size > MAX_FILE_BYTES) return [];
      const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      const value = parsed as { version?: unknown; projectRoot?: unknown; records?: unknown };
      if (value.version !== 1 || value.projectRoot !== this.root || !Array.isArray(value.records)
        || value.records.length > MAX_RECORDS || value.records.some(record => !validateRecord(record))) return [];
      return structuredClone(value.records).map(record => ({ ...record, approved: false }));
    } catch { return []; }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private async write(records: MemoryRecord[]): Promise<void> {
    await this.checkDirectory(true);
    const raw = JSON.stringify({ version: 2, projectId: this.projectId, projectRoot: this.root, projectIdentity: this.identity, records } satisfies MemoryFile);
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) throw new Error('Project memory is over 256 KiB.');
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, this.file); } catch (error) { await rm(temporary, { force: true }); throw error; }
    await chmod(this.file, 0o600);
  }
}

export function cleanMemoryText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Memory text must be text.');
  const text = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new Error('Memory text must be 1–1500 UTF-8 bytes.');
  return text;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}
