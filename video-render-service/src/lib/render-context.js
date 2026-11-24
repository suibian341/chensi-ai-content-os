import { AsyncLocalStorage } from 'node:async_hooks';

const renderContext = new AsyncLocalStorage();

export function runWithRenderSignal(signal, callback) {
  return renderContext.run({ signal }, callback);
}

export function currentRenderSignal() {
  return renderContext.getStore()?.signal || null;
}

