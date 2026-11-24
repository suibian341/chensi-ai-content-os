import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runCommand } from '../providers/media.js';
import { safeFilename } from './storage.js';

const MUSIC_ID_PATTERN = /^bgm_[a-f0-9]{32}$/;
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac']);
const TRANSIENT_FILE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

export class BackgroundMusicError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isBackgroundMusicId(value) {
  return MUSIC_ID_PATTERN.test(String(value || ''));
}

async function retryFileOperation(operation, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!TRANSIENT_FILE_ERRORS.has(error?.code) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(400, 25 * (2 ** attempt))));
    }
  }
}

function publicRecord(record) {
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    durationSeconds: record.durationSeconds,
    createdAt: record.createdAt,
    contentUrl: `/v1/background-music/${record.id}/content`,
  };
}

function extensionForUpload(name, mimeType) {
  const extension = path.extname(String(name || '')).toLowerCase();
  const looksLikeAudio = String(mimeType || '').toLowerCase().startsWith('audio/');
  if (!AUDIO_EXTENSIONS.has(extension) || !looksLikeAudio) {
    throw new BackgroundMusicError('BACKGROUND_MUSIC_FORMAT_INVALID', 'Only MP3, WAV, M4A, AAC, OGG, OPUS, and FLAC audio files are supported', 415);
  }
  return extension;
}

async function probeAudio(filePath, config) {
  let stdout;
  try {
    ({ stdout } = await runCommand(config.media.ffprobePath, [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', filePath,
    ], {
      timeoutMs: Math.min(config.media.timeoutMs, 30_000),
      errorCode: 'BACKGROUND_MUSIC_PROBE_FAILED',
      errorMessage: 'Unable to inspect background music',
    }));
  } catch {
    throw new BackgroundMusicError('BACKGROUND_MUSIC_INVALID', 'The uploaded file is not valid audio');
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new BackgroundMusicError('BACKGROUND_MUSIC_INVALID', 'The uploaded file is not valid audio');
  }
  const durationSeconds = Number(payload?.format?.duration);
  if (!payload?.streams?.length || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new BackgroundMusicError('BACKGROUND_MUSIC_INVALID', 'The uploaded file does not contain a valid audio stream');
  }
  return Math.round(durationSeconds * 100) / 100;
}

export function createBackgroundMusicLibrary(config) {
  const root = path.join(config.storage.root, 'background-music');
  const filesRoot = path.join(root, 'files');
  const uploadRoot = path.join(root, 'uploads');
  const registryPath = path.join(root, 'library.json');
  let recordsPromise;
  let mutationQueue = Promise.resolve();

  const load = async () => {
    if (!recordsPromise) {
      recordsPromise = (async () => {
        const parsed = await fs.readFile(registryPath, 'utf8')
          .then((content) => JSON.parse(content))
          .catch((error) => {
            if (error?.code === 'ENOENT') return [];
            throw error;
          });
        const records = Array.isArray(parsed) ? parsed : [];
        const available = [];
        for (const record of records) {
          if (!isBackgroundMusicId(record?.id) || !record?.filePath) continue;
          const stat = await fs.stat(record.filePath).catch(() => null);
          if (stat?.isFile()) available.push({ ...record, sizeBytes: stat.size });
        }
        return available;
      })();
    }
    return recordsPromise;
  };

  const persist = async (records) => {
    await fs.mkdir(root, { recursive: true });
    const content = `${JSON.stringify(records, null, 2)}\n`;
    const temporary = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, 'utf8');
    try {
      await retryFileOperation(() => fs.rename(temporary, registryPath));
    } catch (error) {
      if (!TRANSIENT_FILE_ERRORS.has(error?.code)) throw error;
      await retryFileOperation(() => fs.writeFile(registryPath, content, 'utf8'));
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };

  const mutate = (operation) => {
    const running = mutationQueue.then(operation, operation);
    mutationQueue = running.catch(() => {});
    return running;
  };

  const findRecord = async (id) => {
    if (!isBackgroundMusicId(id)) return null;
    const records = await load();
    const record = records.find((item) => item.id === id);
    if (!record) return null;
    const stat = await fs.stat(record.filePath).catch(() => null);
    return stat?.isFile() ? { ...record, sizeBytes: stat.size } : null;
  };

  return {
    async list() {
      const records = await load();
      return records.map(publicRecord);
    },

    async resolve(id) {
      const record = await findRecord(id);
      return record ? { ...publicRecord(record), filePath: record.filePath, sha256: record.sha256 } : null;
    },

    async upload(stream, { name, mimeType, declaredLength }) {
      const filename = safeFilename(name, 'background-music.mp3');
      const extension = extensionForUpload(filename, mimeType);
      const expectedBytes = Number(declaredLength);
      if (Number.isFinite(expectedBytes) && (expectedBytes <= 0 || expectedBytes > config.storage.maxBackgroundMusicBytes)) {
        throw new BackgroundMusicError('BACKGROUND_MUSIC_SIZE_INVALID', 'Background music file size is invalid', 413);
      }
      await fs.mkdir(uploadRoot, { recursive: true });
      const temporary = path.join(uploadRoot, `${process.pid}-${randomUUID()}${extension}.tmp`);
      const hash = createHash('sha256');
      let sizeBytes = 0;
      const verifier = new Transform({
        transform(chunk, encoding, callback) {
          sizeBytes += chunk.length;
          if (sizeBytes > config.storage.maxBackgroundMusicBytes) {
            callback(new BackgroundMusicError('BACKGROUND_MUSIC_TOO_LARGE', 'Background music file is too large', 413));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(stream, verifier, createWriteStream(temporary, { flags: 'wx' }));
        if (!sizeBytes || (Number.isFinite(expectedBytes) && expectedBytes !== sizeBytes)) {
          throw new BackgroundMusicError('BACKGROUND_MUSIC_SIZE_MISMATCH', 'Background music size does not match the request');
        }
        const sha256 = hash.digest('hex');
        const durationSeconds = await probeAudio(temporary, config);
        return await mutate(async () => {
          const records = await load();
          const duplicate = records.find((item) => item.sha256 === sha256);
          if (duplicate && await fs.stat(duplicate.filePath).then((stat) => stat.isFile()).catch(() => false)) {
            return { music: publicRecord(duplicate), created: false };
          }
          const id = `bgm_${sha256.slice(0, 32)}`;
          await fs.mkdir(filesRoot, { recursive: true });
          const filePath = path.join(filesRoot, `${id}${extension}`);
          await retryFileOperation(() => fs.rename(temporary, filePath));
          const record = {
            id,
            name: filename,
            mimeType: String(mimeType).toLowerCase(),
            sizeBytes,
            durationSeconds,
            sha256,
            filePath,
            createdAt: new Date().toISOString(),
          };
          records.unshift(record);
          await persist(records);
          return { music: publicRecord(record), created: true };
        });
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    },

    async remove(id, { isInUse = () => false } = {}) {
      if (!isBackgroundMusicId(id)) throw new BackgroundMusicError('BACKGROUND_MUSIC_ID_INVALID', 'Background music id is invalid');
      return mutate(async () => {
        const records = await load();
        const index = records.findIndex((item) => item.id === id);
        if (index < 0) throw new BackgroundMusicError('BACKGROUND_MUSIC_NOT_FOUND', 'Background music was not found', 404);
        if (isInUse(id)) throw new BackgroundMusicError('BACKGROUND_MUSIC_IN_USE', 'Background music is currently used by a queued or running job', 409);
        const [record] = records.splice(index, 1);
        await persist(records);
        await retryFileOperation(() => fs.rm(record.filePath, { force: true }));
        return publicRecord(record);
      });
    },
  };
}
