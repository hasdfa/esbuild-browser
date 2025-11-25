// Credits: https://github.com/esbuild/esbuild.github.io/blob/main/src/try/ipc.ts
import type {FormatMessagesOptions} from 'esbuild-wasm';
import PQueue from 'p-queue';
import {emitter} from './global';

export type IPCStatus = 'resolve' | 'reject' | 'progress';

export interface IPCInitOptions {
  esbuildVersion: string;
  workerUrl: string;
  // Dynamic pool size bounds. If omitted, defaults are min=2, max=5.
  minConcurrency?: number;
  maxConcurrency?: number;
}

export interface OutputFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

export type IPCRequest = TransformRequest | BuildRequest | NpmInstallRequest;
export type IPCResponse<Request extends IPCRequest = IPCRequest> =
  Request extends TransformRequest
    ? TransformResponse
    : Request extends BuildRequest
    ? BuildResponse
    : Request extends NpmInstallRequest
    ? NpmInstallResponse
    : TransformRequest & BuildRequest & NpmInstallRequest;

export interface TransformRequest {
  command_: 'transform';
  input_: string;
  options_: Record<string, any>;
  formatOptions?: Partial<FormatMessagesOptions>;
}

export interface TransformResponse {
  code_?: string;
  map_?: string;
  mangleCache_?: Record<string, string | boolean>;
  legalComments_?: string;
  stderr_?: string;
  duration_?: number;
}

export interface BuildRequest {
  command_: 'build';
  input_: Record<string, string>;
  options_: Record<string, any>;
  formatOptions?: Partial<FormatMessagesOptions>;
}

export interface NpmInstallRequest {
  command_: 'npm_install';
  registryBaseUrl_: string;
  input_: Record<string, string>;
  cwd_?: string;
}

export interface NpmInstallResponse {}

export interface BuildResponse {
  metafile_?: Record<string, any>;
  outputFiles_: OutputFile[];
  mangleCache_?: Record<string, string | boolean>;
  duration_: number;
  stderr_?: string;
  stdout?: string; // JSON stringified object of errors and warnings
}

interface Task {
  message_: any;
  resolve_: (value: any) => void;
  abort_: () => void;
}

let workerText: Promise<string> | null = null;

// Waiting to a resolved function
let waitingPromise: Record<
  string,
  {
    resolve: (data: any) => void;
    reject: (error: any) => void;
    progress?: (data: any) => void;
  }
> = {};

let on_reload: (options: IPCInitOptions) => Promise<Worker[]> = async () =>
  null as any;
emitter.on('reload', options => on_reload(options));

let workerPoolPromise = new Promise<Worker[]>((resolve, reject) => {
  on_reload = options => {
    const reloadPromise = reloadWorkerPool(options);
    reloadPromise.then(resolve, reject);
    on_reload = options => {
      workerPoolPromise.then(workers => workers.forEach(w => w.terminate()));
      workerPoolPromise = reloadWorkerPool(options);
      return workerPoolPromise;
    };
    return reloadPromise;
  };
});

// Pool state for scheduling
let availableWorkers: Worker[] = [];
let poolQueue: PQueue | null = null;

const do_fetch: typeof fetch = (url, options) => {
  emitter.status = `Fetching ${url}`;
  return fetch(url, options);
};

async function packageFetch(subpath: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('Timeout'), 5000);

  // Try to fetch from one CDN, but fall back to another CDN if that fails
  try {
    const response = await do_fetch(`https://cdn.jsdelivr.net/npm/${subpath}`);
    if (response.ok) {
      clearTimeout(timeout);
      return response;
    }
  } catch (err) {
    console.error(err);
  }
  return do_fetch(`https://unpkg.com/${subpath}`);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function decidePoolSize(options: IPCInitOptions): number {
  const min = options.minConcurrency ?? 2;
  const max = options.maxConcurrency ?? 5;
  const hw = (typeof navigator !== 'undefined' && navigator && navigator.hardwareConcurrency) || 2;
  return clamp(hw, min, max);
}

async function reloadWorkerPool(options: IPCInitOptions): Promise<Worker[]> {
  const {esbuildVersion: version, workerUrl} = options;

  let loadingFailure: string | undefined;
  emitter.status = `Loading esbuild ${version}…`;

  try {
    // Abort all pending promises
    for (const [id, entry] of Object.entries(waitingPromise)) {
      try {
        entry?.reject?.(new Error('Task aborted due to reload'));
      } catch {}
      delete waitingPromise[id];
    }

    // "browser.min.js" was added in version 0.8.33
    const [major, minor, patch] = version.split('.').map(x => +x);
    const min =
      major === 0 && (minor < 8 || (minor === 8 && patch < 33)) ? '' : '.min';

    const [workerJS, esbuildJS, esbuildWASM] = await Promise.all([
      (workerText ||= fetch(workerUrl).then(r => r.text())),
      packageFetch(`esbuild-wasm@${version}/lib/browser${min}.js`).then(r =>
        r.text(),
      ),
      packageFetch(`esbuild-wasm@${version}/esbuild.wasm`).then(r =>
        r.arrayBuffer(),
      ),
    ]);
    setupLocal(esbuildJS, esbuildWASM.slice(0));

    const i = workerJS.lastIndexOf('//# sourceMappingURL=');
    const workerJSWithoutSourceMap = i >= 0 ? workerJS.slice(0, i) : workerJS;
    const parts = [esbuildJS, `\nvar polywasm=1;`, workerJSWithoutSourceMap];

    const createWorkerInstance = (): Promise<Worker> => {
      const url = URL.createObjectURL(
        new Blob(parts, {type: 'application/javascript'}),
      );
      return new Promise<Worker>((resolve, reject) => {
        const worker = new Worker(url, {type: 'module'});
        worker.onmessage = e => {
          worker.onmessage = null;

          if (e.data[0] === 'success') {
            // After init, route all messages via the waitingPromise map
            worker.onmessage = e => {
              if (
                e.data &&
                Array.isArray(e.data) &&
                e.data.length === 3 &&
                waitingPromise[e.data[0]]
              ) {
                const [id, status, data] = e.data;
                waitingPromise[id]?.[status]?.(data);

                // If the promise is resolved or rejected, remove it from the waiting list
                if (['resolve', 'reject'].includes(status)) {
                  delete waitingPromise[id];
                }
              }
            };
            resolve(worker);
          } else {
            reject(new Error('Failed to create worker'));
            loadingFailure = e.data[1];
          }
          URL.revokeObjectURL(url);
        };
        worker.postMessage(['setup', version, esbuildWASM], [esbuildWASM]);
      });
    };

    const poolSize = decidePoolSize(options);
    const workers = await Promise.all(Array.from({length: poolSize}, () => createWorkerInstance()));

    // Initialize pool scheduling
    availableWorkers = [...workers];
    poolQueue = new PQueue({concurrency: workers.length});

    emitter.status = `Loaded esbuild ${version} (x${workers.length})`;
    emitter.ready = true;
    return workers;
  } catch (err) {
    emitter.status = loadingFailure || err + '';
    console.error('reloadWorker', err);
    throw err;
  }
}

let script: HTMLScriptElement | null = null;
function setupLocal(js: string, wasm: ArrayBuffer): void {
  const url = URL.createObjectURL(
    new Blob([js], {type: 'application/javascript'}),
  );
  if (script) script.remove();
  script = document.createElement('script');
  script.onload = async () => {
    const esbuild: typeof import('esbuild') = (window as any).esbuild;
    const options = {
      wasmURL: URL.createObjectURL(
        new Blob([wasm], {type: 'application/wasm'}),
      ),
    };
    if ((esbuild as any).startService) {
      await (esbuild as any).startService(options);
    } else {
      await esbuild.initialize(options);
    }
    console.log('loaded esbuild @', esbuild.version, esbuild);
  };
  script.src = url;
  document.head.appendChild(script);
}

export function sendIPC<Request extends IPCRequest>(
  message: Request,
  progress?: (data: any) => void,
): Promise<IPCResponse<Request>> {
  // console.log('sendIPC', message)

  // function activateTask(worker: Worker, task: Task): void {
  //   console.log('activateTask', worker, task)

  //   if (activeTask) {
  //     if (pendingTask) pendingTask.abort_()
  //     pendingTask = task
  //   } else {
  //     activeTask = task
  //     worker.onmessage = (e) => {
  //       worker.onmessage = null
  //       task.resolve_(e.data)
  //       activeTask = null
  //       if (pendingTask) {
  //         activateTask(worker, pendingTask)
  //         pendingTask = null
  //       }
  //     }
  //     console.log('postMessage', task.message_)
  //     worker.postMessage(task.message_)
  //   }
  // }

  // return new Promise((resolve, reject) => {
  //   workerPromise.then(
  //     (worker) =>
  //       activateTask(worker, {
  //         message_: message,
  //         resolve_: resolve,
  //         abort_: () => reject(new Error('Task aborted')),
  //       }),
  //     reject,
  //   )
  // })

  return workerPoolPromise.then(() => {
    if (!poolQueue) throw new Error('Worker pool not initialized');

    return poolQueue.add(async () => {
      // Acquire a worker
      const worker = availableWorkers.pop();
      if (!worker) {
        // Should not happen due to poolQueue concurrency == pool size
        throw new Error('No available worker');
      }

      const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? (crypto as any).randomUUID()
        : Math.random().toString(36).substring(2, 15);

      const promise = new Promise<IPCResponse<Request>>(
        (promiseResolve, promiseReject) => {
          waitingPromise[id] = {
            progress,
            resolve: (data: any) => {
              // Release worker on completion
              availableWorkers.push(worker);
              promiseResolve(data);
            },
            reject: (error: any) => {
              availableWorkers.push(worker);
              promiseReject(error);
            },
          };
        },
      );

      worker.postMessage([id, message]);
      return promise;
    }, {
      throwOnTimeout: true,
    });
  });
}
