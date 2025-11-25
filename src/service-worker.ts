/// <reference lib="webworker" />

const PREVIEW_DOMAIN_SUFFIX = '{{PREVIEW_DOMAIN_SUFFIX}}';
const hasPreviewDomainSuffix =
  !PREVIEW_DOMAIN_SUFFIX.startsWith('{{') &&
  !PREVIEW_DOMAIN_SUFFIX.endsWith('}}');

// Store for uploaded files
const fileStore = new Map();

const SECURITY_HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'content-security-policy':
    "default-src * data: mediastream: blob: filesystem: about: ws: wss: 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline'; script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; script-src-elem * data: blob: 'unsafe-inline'; connect-src * data: blob: 'unsafe-inline'; img-src * data: blob: 'unsafe-inline'; media-src * data: blob: 'unsafe-inline'; frame-src * data: blob: ; style-src * data: blob: 'unsafe-inline'; font-src * data: blob: 'unsafe-inline'; frame-ancestors *;",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'x-nf-request-id': '01K1K2GYTJFG0PBG936G3ABJEE',
  'x-xss-protection': '1; mode=block',
};

// Helper function to determine content type based on file extension
function getContentType(filePath) {
  const extension = filePath.split('.').pop().toLowerCase();
  const contentTypes = {
    js: 'application/javascript',
    css: 'text/css',
    html: 'text/html',
    json: 'application/json',
    map: 'application/json', // .js.map
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  };

  return contentTypes[extension] || 'application/octet-stream';
}

// Helper to get cache name for a project
function getCacheName(projectId) {
  return `esbuild-files-${projectId}`;
}

// Handle messages from the main thread
self.addEventListener('message', async (event: MessageEvent) => {
  if (event.data.type === 'UPLOAD_FILES') {
    const {projectId, files} = event.data.payload;

    // Store files in memory
    fileStore.set(projectId, files);

    // Store files in persistent cache
    const cache = await caches.open(getCacheName(projectId));
    // Remove old cache entries for this project
    const keys = await cache.keys();
    for (const request of keys) {
      await cache.delete(request);
    }
    // Add new files
    for (const [filePath, fileContent] of Object.entries(files)) {
      const url = `/${projectId}/${filePath}`;
      // Ensure fileContent is a valid BodyInit (string, Blob, ArrayBuffer, etc.)
      let body: BodyInit;
      if (
        typeof fileContent === 'string' ||
        fileContent instanceof Blob ||
        fileContent instanceof ArrayBuffer
      ) {
        body = fileContent;
      } else if (fileContent instanceof Uint8Array) {
        body = fileContent as any;
      } else {
        // Fallback: try to convert to string
        body = String(fileContent);
      }

      await cache.put(
        url,
        new Response(body, {
          headers: {
            'Content-Type': getContentType(filePath),
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
          },
        }),
      );
    }

    // Send confirmation back to main thread
    event.source?.postMessage({
      type: 'UPLOAD_COMPLETE',
      projectId,
    });
  }
});

// Handle fetch events
self.addEventListener('fetch', (event: Event) => {
  const fetchEvent = event as FetchEvent;
  const url = new URL(fetchEvent.request.url);

  if (hasPreviewDomainSuffix && url.hostname.endsWith(PREVIEW_DOMAIN_SUFFIX)) {
    const projectId = url.hostname.slice(0, -PREVIEW_DOMAIN_SUFFIX.length);
    const filePath = url.pathname;

    const projectFiles = fileStore.get(projectId);
    if (projectFiles && filePath in projectFiles) {
      const response = new Response(projectFiles[filePath], {
        headers: {
          'Content-Type': getContentType(filePath),
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        },
      });
      fetchEvent.respondWith(response);
      return;
    }

    fetchEvent.respondWith(new Response('Not Found', {status: 404}));
    return;
  }

  // Check if the request matches our pattern
  if (url.pathname.startsWith('/__build/')) {
    const pathParts = url.pathname.split('/');
    const projectId = pathParts[2];
    const filePath = pathParts.slice(3).join('/') || 'index.html';

    // Get the project's files
    const projectFiles = fileStore.get(projectId);
    if (projectFiles && filePath in projectFiles) {
      // Create a response with the file content
      const response = new Response(projectFiles[filePath], {
        headers: {
          'Content-Type': getContentType(filePath),
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        },
      });
      fetchEvent.respondWith(response);
      return;
    }

    // If not in memory, check persistent cache
    fetchEvent.respondWith(
      (async () => {
        const cache = await caches.open(getCacheName(projectId));
        const cachedResponse = await cache.match(`/${projectId}/${filePath}`);
        if (cachedResponse) {
          // Optionally repopulate fileStore for faster access next time
          if (projectFiles) {
            // If projectFiles exists, add this file
            const cloned = await cachedResponse.clone().arrayBuffer();
            projectFiles[filePath] = cloned;
          } else {
            // If not, create a new entry
            const cloned = await cachedResponse.clone().arrayBuffer();
            fileStore.set(projectId, {[filePath]: cloned});
          }
          return cachedResponse;
        }
        return new Response(`File '${filePath}' was Not Found`, {status: 404});
      })(),
    );
  }
});
