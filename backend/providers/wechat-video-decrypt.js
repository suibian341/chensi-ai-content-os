import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ProviderError } from '../lib/http.js';

const KEYSTREAM_SIZE = 131_072;
const WASM_SCRIPT_URL = 'https://res.wx.qq.com/t/wx_fed/cdn_libs/res/decrypt-video-core/1.3.0/wasm_video_decode.js';
const WASM_BINARY_URL = 'https://res.wx.qq.com/t/wx_fed/cdn_libs/res/decrypt-video-core/1.3.0/wasm_video_decode.wasm';
const RESOURCE_HASHES = {
  [WASM_SCRIPT_URL]: '78faf7621959e30ba05c0acf7182dd14bcbd7dfe45529476649f39b20e5dbea3',
  [WASM_BINARY_URL]: 'dca796bacec37d8522c7983b3945e5d579bd74164e3b21f0ebc773be6dfc8b6e'
};
const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_KEYSTREAM_CACHE = 100;

let runtimePromise = null;
let generationQueue = Promise.resolve();
const keystreamCache = new Map();

function hasMp4Signature(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 32).indexOf(Buffer.from('ftyp')) >= 0;
}

async function fetchVerifiedResource(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new ProviderError('WECHAT_VIDEO_DECRYPT_COMPONENT_UNAVAILABLE', '视频号解密组件暂时无法加载，请稍后重试', {
      status: 503,
      retryable: true,
      details: error instanceof Error ? error.message : String(error)
    });
  }
  if (!response.ok) {
    throw new ProviderError('WECHAT_VIDEO_DECRYPT_COMPONENT_UNAVAILABLE', '视频号解密组件暂时无法加载，请稍后重试', {
      status: 503,
      retryable: response.status >= 500,
      details: `HTTP ${response.status}`
    });
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESOURCE_BYTES) {
    throw new ProviderError('WECHAT_VIDEO_DECRYPT_COMPONENT_INVALID', '视频号解密组件校验失败，请联系管理员', { status: 503 });
  }
  const data = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(data).digest('hex');
  if (!data.length || data.length > MAX_RESOURCE_BYTES || digest !== RESOURCE_HASHES[url]) {
    throw new ProviderError('WECHAT_VIDEO_DECRYPT_COMPONENT_INVALID', '视频号解密组件校验失败，请联系管理员', { status: 503 });
  }
  return data;
}

async function createRuntime() {
  const [scriptData, wasmBinary] = await Promise.all([
    fetchVerifiedResource(WASM_SCRIPT_URL),
    fetchVerifiedResource(WASM_BINARY_URL)
  ]);
  const require = createRequire(import.meta.url);
  const filename = fileURLToPath(import.meta.url);
  let capturedKeystream = null;
  let resolveInit;
  let rejectInit;
  const initialized = new Promise((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });
  const context = {
    console: { log() {}, error() {}, warn() {} },
    Buffer,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    Array,
    Object,
    Function,
    String,
    Number,
    Boolean,
    Error,
    Promise,
    WebAssembly,
    TextDecoder,
    TextEncoder,
    require,
    process,
    __dirname: path.dirname(filename),
    __filename: filename,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  context.Module = {
    wasmBinary,
    print() {},
    printErr() {},
    onRuntimeInitialized: resolveInit,
    onAbort: (reason) => rejectInit(new Error(String(reason || 'WASM aborted')))
  };
  context.global = context;
  context.globalThis = context;
  context.self = context;
  context.self.location = { href: WASM_SCRIPT_URL };
  context.WorkerGlobalScope = function WorkerGlobalScope() {};
  context.VTS_WASM_URL = WASM_BINARY_URL;
  context.wasm_isaac_generate = (pointer, size) => {
    const generated = new Uint8Array(context.Module.HEAPU8.buffer, pointer, size);
    capturedKeystream = Buffer.from(generated);
  };

  try {
    const sandbox = vm.createContext(context);
    new vm.Script(scriptData.toString('utf8'), { filename: WASM_SCRIPT_URL }).runInContext(sandbox, { timeout: 30_000 });
    let initializationTimer;
    try {
      await Promise.race([
        initialized,
        new Promise((_, reject) => {
          initializationTimer = setTimeout(() => reject(new Error('WASM initialization timed out')), 30_000);
        })
      ]);
    } finally {
      clearTimeout(initializationTimer);
    }
  } catch (error) {
    throw new ProviderError('WECHAT_VIDEO_DECRYPT_COMPONENT_UNAVAILABLE', '视频号解密组件初始化失败，请稍后重试', {
      status: 503,
      retryable: true,
      details: error instanceof Error ? error.message : String(error)
    });
  }

  return {
    generate(decodeKey) {
      if (!context.Module.WxIsaac64) throw new Error('WxIsaac64 is unavailable');
      capturedKeystream = null;
      const decryptor = new context.Module.WxIsaac64(decodeKey);
      try {
        decryptor.generate(KEYSTREAM_SIZE);
      } finally {
        decryptor.delete?.();
      }
      if (!capturedKeystream || capturedKeystream.length < KEYSTREAM_SIZE) {
        throw new Error('The decryption component returned an empty keystream');
      }
      return Buffer.from(capturedKeystream).reverse().subarray(0, KEYSTREAM_SIZE);
    }
  };
}

function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = createRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

function cachedKeystream(decodeKey) {
  const key = String(decodeKey);
  const value = keystreamCache.get(key);
  if (!value) return null;
  keystreamCache.delete(key);
  keystreamCache.set(key, value);
  return value;
}

function rememberKeystream(decodeKey, value) {
  const key = String(decodeKey);
  keystreamCache.set(key, value);
  if (keystreamCache.size > MAX_KEYSTREAM_CACHE) {
    keystreamCache.delete(keystreamCache.keys().next().value);
  }
}

export function decryptWechatVideoBuffer(encrypted, keystream) {
  const input = Buffer.from(encrypted || []);
  const key = Buffer.from(keystream || []);
  const decrypted = Buffer.from(input);
  const length = Math.min(KEYSTREAM_SIZE, decrypted.length, key.length);
  for (let index = 0; index < length; index += 1) decrypted[index] ^= key[index];
  return decrypted;
}

export async function generateWechatKeystream(decodeKey) {
  const key = String(decodeKey ?? '').trim();
  if (!/^\d+$/.test(key)) {
    throw new ProviderError('WECHAT_VIDEO_DECODE_KEY_INVALID', '视频号作品没有返回有效的解密信息', { status: 422 });
  }
  const cached = cachedKeystream(key);
  if (cached) return cached;

  const operation = generationQueue.catch(() => {}).then(async () => {
    const secondHit = cachedKeystream(key);
    if (secondHit) return secondHit;
    try {
      const runtime = await getRuntime();
      const generated = runtime.generate(key);
      rememberKeystream(key, generated);
      return generated;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('WECHAT_VIDEO_DECRYPT_FAILED', '视频号作品解密失败，请重新解析后再试', {
        status: 422,
        retryable: true,
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });
  generationQueue = operation;
  return operation;
}

export async function decryptWechatVideo(encrypted, decodeKey) {
  const input = Buffer.from(encrypted || []);
  if (hasMp4Signature(input)) return input;
  const keystream = await generateWechatKeystream(decodeKey);
  const decrypted = decryptWechatVideoBuffer(input, keystream);
  if (!hasMp4Signature(decrypted)) {
    throw new ProviderError('WECHAT_VIDEO_DECRYPT_FAILED', '视频号作品解密失败，请重新解析后再试', {
      status: 422,
      retryable: true
    });
  }
  return decrypted;
}
