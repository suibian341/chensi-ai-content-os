import { promises as fs } from 'node:fs';

const transientFileErrorCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function isTransientFileError(error) {
  return transientFileErrorCodes.has(error?.code);
}

export async function retryTransientFileOperation(operation, {
  attempts = 12,
  initialDelayMs = 25,
  maxDelayMs = 500
} = {}) {
  const totalAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFileError(error) || attempt === totalAttempts - 1) throw error;
      const delayMs = Math.min(maxDelayMs, initialDelayMs * (2 ** attempt));
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
    }
  }
}

async function writeFileDurably(filePath, content) {
  const handle = await fs.open(filePath, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function replaceFileDurably(tempFile, destinationFile, content) {
  try {
    await retryTransientFileOperation(() => fs.rename(tempFile, destinationFile));
    return { method: 'rename', renameError: null };
  } catch (renameError) {
    if (!isTransientFileError(renameError)) throw renameError;
    await retryTransientFileOperation(() => writeFileDurably(destinationFile, content));
    return { method: 'in-place', renameError };
  }
}
