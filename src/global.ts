import { IPCInitOptions } from "./ipc";

interface Value {
  ready: boolean;
  reload: IPCInitOptions;
  status: string;
}

const value: Value = {
  ready: false,
  status: '',
  reload: {
    esbuildVersion: '',
    workerUrl: '',
  },
}

const listeners: Record<string, ((value: any) => void)[]> = {}

function emit(event: string, value: any) {
  if (listeners[event]) {
    listeners[event].forEach(listener => listener(value));
  }
}

export const emitter = {
  set ready(v: Value['ready']) {
    value.ready = v;
    emit('ready', v);
  },
  set reload(v: Value['reload']) {
    value.reload = v;
    emit('reload', v);
  },
  set status(v: Value['status']) {
    value.status = v;
    emit('status', v);
  },
  get ready() {
    return value.ready;
  },
  get reload() {
    return value.reload;
  },
  get status() {
    return value.status;
  },
  on: <Ev extends keyof Value>(event: Ev, callback: (value: Value[Ev]) => void) => {
    listeners[event] = listeners[event] || [];
    listeners[event].push(callback);
  },
}
