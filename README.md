# @vraksha/esbuild-browser

Run [esbuild](https://esbuild.github.io/) entirely in the browser using WebAssembly. Bundle JavaScript/TypeScript code, install npm packages, and serve the output—all without a backend.

## Features

- 🚀 **In-browser bundling** — Full esbuild bundling powered by WebAssembly
- 📦 **NPM package installation** — Install dependencies from a custom registry CDN
- 💾 **Virtual file system** — Manage project files in memory
- ⚡ **Service worker** — Serve bundled files directly from the browser
- 🔄 **Persistent caching** — IndexedDB-based caching for installed packages

## Installation

```bash
pnpm add @vraksha/esbuild-browser
```

## Quick Start

```typescript
import { initWorker } from '@vraksha/esbuild-browser';

// Initialize the worker
const worker = await initWorker({
  esbuildVersion: '0.27.0',
  workerUrl: '/worker.js', // URL to the bundled worker script
});

// Write files to the virtual file system
worker.fs.writeFile('/app/index.ts', `
  import { greet } from './utils';
  console.log(greet('World'));
`);

worker.fs.writeFile('/app/utils.ts', `
  export function greet(name: string): string {
    return \`Hello, \${name}!\`;
  }
`);

// Bundle the code
const result = await worker.esbuild__bundle({
  entryPoints: ['/app/index.ts'],
  write: false,
});

console.log(result.outputFiles_);
```

## API Reference

### `initWorker(options)`

Initializes the esbuild worker and returns an object with bundling utilities.

#### Options

| Property | Type | Description |
|----------|------|-------------|
| `esbuildVersion` | `string` | The version of esbuild-wasm to use (e.g., `'0.27.0'`) |
| `workerUrl` | `string` | URL to the worker script (`@vraksha/esbuild-browser/worker`) |

#### Returns

```typescript
{
  fs: FileSystemManager;
  npm__install: (props) => Promise<void>;
  esbuild__bundle: (options, props?) => Promise<BuildResponse>;
}
```

---

### `npm__install(props)`

Install npm packages from a registry CDN.

```typescript
worker.fs.writeFile('/app/package.json', JSON.stringify({
  "name": "my-app",
  "version": "1.1.0",
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@emotion/cache": "^11.14.0",
    "@emotion/react": "^11.14.0",
    "@emotion/styled": "^11.14.0",
    "@mui/material": "^7.3.5"
  }
}, null, 2));

// This function parse dependencies from package.json
await worker.npm__install({
  registryBaseUrl: 'https://your-registry-cdn.com',
  cwd: '/app', // Optional: working directory
  progress: (type, message) => {
    console.log(`[${type}] ${message}`);
  },
});
```

#### Props

| Property | Type | Description |
|----------|------|-------------|
| `registryBaseUrl` | `string` | Base URL of your npm registry CDN |
| `cwd` | `string?` | Working directory containing `package.json` |
| `rawFiles` | `Record<string, string>?` | Override files (defaults to `fs.rawFiles`) |
| `progress` | `(type, message) => void` | Progress callback for installation logs |

---

### `esbuild__bundle(options, props?)`

Bundle code using esbuild with sensible defaults.

```typescript
const result = await worker.esbuild__bundle({
  entryPoints: ['/app/index.tsx'],
});
```

#### Default Options

The bundler applies these defaults (can be overridden):

```typescript
{
  target: 'chrome67',
  format: 'esm',
  splitting: true,
  bundle: true,
  sourcemap: true,
  minify: false,
  loader: {
    '.html': 'copy',
    '.svg': 'file',
    '.png': 'file',
    '.jpg': 'file',
    '.jpeg': 'file',
    '.gif': 'file',
    '.ico': 'file',
    '.webp': 'file',
  },
}
```

#### Response

```typescript
interface BuildResponse {
  outputFiles_: Array<{ path: string; contents: Uint8Array }>;
  metafile_?: Record<string, any>;
  duration_: number;
  stderr_?: string;
}
```

---

### `FileSystemManager`

A virtual file system for managing project files in memory.

```typescript
const { fs } = await initWorker({ /* ... */ });

// Write a file
fs.writeFile('/app/index.ts', 'console.log("hello")');

// Read a file
const content = fs.readFile('/app/index.ts');

// Check if file exists
const exists = fs.exists('/app/index.ts');

// Set multiple files at once
fs.setFiles({
  '/app/index.ts': { contents: '...', isEntry: true },
  '/app/utils.ts': { contents: '...' },
});

// List directory contents
const files = fs.readdir('/app');

// Delete a file
fs.deleteFile('/app/index.ts');

// Get all files as raw strings
const rawFiles = fs.rawFiles; // Record<string, string>
```

---

## Service Worker Setup

The package includes a service worker for serving bundled output files. This enables previewing bundled applications directly in the browser.

### Registration

```typescript
// Register the service worker
navigator.serviceWorker.register('/service-worker.js');

// Upload files to be served
navigator.serviceWorker.ready.then((registration) => {
  registration.active?.postMessage({
    type: 'UPLOAD_FILES',
    payload: {
      projectId: 'my-project',
      files: {
        'index.html': '<html>...</html>',
        'bundle.js': '...',
      },
    },
  });
});
```

### Accessing Built Files

Once files are uploaded, they're accessible at:

```
/__build/{projectId}/{filepath}
```

For example: `/__build/my-project/index.html`

---

## Complete Example

```typescript
import { initWorker } from '@vraksha/esbuild-browser';

async function main() {
  // 1. Initialize the worker
  const worker = await initWorker({
    esbuildVersion: '0.27.0',
    workerUrl: '/worker.js',
  });

  // 2. Set up project files
  worker.fs.setFiles({
    '/app/package.json': {
      contents: JSON.stringify({
        dependencies: {
          lodash: '^4.17.21',
        },
      }),
    },
    '/app/index.ts': {
      contents: `
        import _ from 'lodash';
        console.log(_.chunk([1, 2, 3, 4], 2));
      `,
      isEntry: true,
    },
  });

  // 3. Install dependencies
  await worker.npm__install({
    registryBaseUrl: 'https://your-sandpack-cdn.com',
    cwd: '/app',
    progress: (type, msg) => console.log(`[npm] ${msg}`),
  });

  // 4. Bundle the code
  const result = await worker.esbuild__bundle({
    entryPoints: ['/app/index.ts'],
  });

  // 5. Use the output - upload to service worker and display in iframe
  const projectId = 'my-project';

  // Convert output files to a format suitable for the service worker
  const files: Record<string, string> = {};
  for (const file of result.outputFiles_) {
    const filename = file.path.replace('/app/', '');
    files[filename] = new TextDecoder().decode(file.contents);
  }

  // Add an index.html that loads the bundle
  files['index.html'] = `
    <!DOCTYPE html>
    <html>
      <head><title>Preview</title></head>
      <body>
        <div id="root"></div>
        <script type="module" src="./index.js"></script>
      </body>
    </html>
  `;

  // Upload files to the service worker
  const registration = await navigator.serviceWorker.ready;
  registration.active?.postMessage({
    type: 'UPLOAD_FILES',
    payload: { projectId, files },
  });

  // Create an iframe to display the preview
  const iframe = document.createElement('iframe');
  iframe.src = `/__build/${projectId}/index.html`;
  iframe.style.width = '100%';
  iframe.style.height = '500px';
  iframe.style.border = '1px solid #ccc';
  document.body.appendChild(iframe);
}

main();
```

---

## Module Exports

The package provides multiple entry points:

```typescript
// Main API
import { initWorker } from '@vraksha/esbuild-browser';

// Worker script (for bundling separately)
import '@vraksha/esbuild-browser/worker';

// Service worker script
import '@vraksha/esbuild-browser/service-worker';
```

---

## Building & Development

```bash
# Install dependencies
pnpm install

# Build the package
pnpm build
```

---

## Requirements

- Modern browser with WebAssembly support
- Service Worker support (for file serving feature)
- IndexedDB support (for caching)

## Credits

This package is inspired by the [esbuild playground](https://github.com/esbuild/esbuild.github.io) implementation.

## License

MIT

