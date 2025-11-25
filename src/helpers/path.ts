export function join(...paths: string[]) {
  // Remove leading/trailing slashes and join with "/"
  return paths
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/g, '') : p.replace(/^\/+|\/+$/g, '')))
    .join('/')
    .replace(/\/+/g, '/');
}

export function resolve(...paths: string[]) {
  let resolvedPath = '';
  for (let i = paths.length - 1; i >= 0; i--) {
    const segment = paths[i];
    if (!segment) continue;
    if (segment.startsWith('/')) {
      resolvedPath = segment + '/' + resolvedPath;
      break;
    } else {
      resolvedPath = segment + '/' + resolvedPath;
    }
  }
  // Normalize
  const parts = resolvedPath.split('/').filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return '/' + stack.join('/');
}

export function dirname(path: string) {
  if (!path) return '.';
  // Remove trailing slashes
  path = path.replace(/\/+$/, '');
  if (!path) return '/';
  const idx = path.lastIndexOf('/');
  if (idx === -1) return '.';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}
