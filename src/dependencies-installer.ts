import {openDB} from 'idb';
import notepack from 'notepack.io';
import PQueue from 'p-queue';
import * as path from './helpers/path';
import type {BaseFileSystemManager as FileSystem} from './file-system-manager';

const {Buffer} = require('buffer');

const requestsQueue = new PQueue({
  concurrency: 10,
  timeout: 60_000,
});

async function fetchWithRetry(
  input: string,
  init?: RequestInit,
  retries = 3,
  delay = 1000,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (retries === 0) {
      throw error;
    }

    await new Promise<Response>(resolve => setTimeout(resolve, delay));
    return fetchWithRetry(input, init, retries - 1, delay);
  }
}

function packagesHash(packages: Record<string, string>) {
  const dependenciesRequest = Object.entries(packages)
    .sort(($1, $2) => $1[0].localeCompare($2[0]))
    .map(([name, version]) => `${name}@${version}`);
  if (!dependenciesRequest) {
    return '';
  }

  return Buffer.from(dependenciesRequest.join(';')).toString('base64');
}

const sandpackClient = {
  async resolvePackages(
    registryBaseUrl: string,
    packages: Record<string, string>,
    packageJsonHash: string,
  ) {
    const newPackageJsonHash = packagesHash(packages);
    if (newPackageJsonHash === packageJsonHash) {
      return {
        packageJsonHash: newPackageJsonHash,
        dependencies: null,
      };
    }

    const requestPath = `/v2/deps/${newPackageJsonHash}`;
    return Cache.withLocalCacheData(
      requestPath,
      async () => {
        const response = await fetchWithRetry(
          `${registryBaseUrl}${requestPath}`,
        );
        const responseBytes = await response.arrayBuffer();

        const distTags: Record<string, string> = notepack.decode(responseBytes);
        const dependencies: Record<string, string> = {};
        const versions: Record<string, number> = {};
        for (const [name, version] of Object.entries(distTags)) {
          const splitted = name.split('@');
          const major = +(splitted.pop() ?? '0');
          const packageName = splitted.join('@');

          const existing = versions[packageName];
          if (!existing || major > existing) {
            versions[packageName] = major;
            dependencies[packageName] = version;
          }
        }

        console.debug('[NPM] distTags', distTags);
        console.debug('[NPM] resolved dependencies', dependencies);

        return {
          packageJsonHash: newPackageJsonHash,
          dependencies: Object.fromEntries(
            Object.entries(distTags).map(([name, version]) => {
              return [name.split('@').slice(0, -1).join('@'), version];
            }),
          ),
        };
      },
      async files => files,
    );
  },
  async hasPackageFilesInCache(packageName: string, packageVersion: string) {
    const packageRequest = Buffer.from(
      `${packageName}@${packageVersion}`,
    ).toString('base64');
    const requestPath = `/v2/mod/${packageRequest}`;

    return Cache.isCached(requestPath);
  },
  async downloadPackageFiles(
    registryBaseUrl: string,
    packageName: string,
    packageVersion: string,
  ) {
    const packageRequest = Buffer.from(
      `${packageName}@${packageVersion}`,
    ).toString('base64');
    const requestPath = `/v2/mod/${packageRequest}`;

    return Cache.withCacheData(
      requestPath,
      async () => {
        const response = await fetchWithRetry(
          `${registryBaseUrl}${requestPath}`,
        );
        const responseBytes = await response.arrayBuffer();
        return responseBytes;
      },
      async responseBytes => {
        const files: Record<string, Buffer> = notepack.decode(responseBytes);
        return files;
      },
    );
  },
};

function measureTime(): () => string {
  const startTime = Date.now();
  return () => {
    const endTime = Date.now();
    let durationMs = endTime - startTime;
    return durationMs > 1000
      ? `${Math.round(durationMs / 1000)}s ${durationMs % 1000}ms`
      : `${durationMs}ms`;
  };
}

export interface NPMSpawnOptions {
  cwd?: string;
  reported?: (type: 'error' | 'info', message: string) => void;
  dependencies?: Record<string, string>;

  // URL of your deployment of sandpack-cdn
  registryBaseUrl: string;
}

export class NPMInstaller {
  private static scriptsMap: Record<string, string> = {};

  private static cwd(fs: FileSystem, options: NPMSpawnOptions) {
    return options?.cwd || fs.cwd() || process.cwd();
  }

  private static async getPackageJson(
    fs: FileSystem,
    options: NPMSpawnOptions,
  ) {
    const packageJsonPath = path.join(this.cwd(fs, options), 'package.json');
    const content = await Promise.resolve(fs.readFile(packageJsonPath)).catch(
      () => null,
    );
    return content ? JSON.parse(content) : null;
  }

  public static async resolveDependencies(
    fs: FileSystem,
    options: NPMSpawnOptions,
  ) {
    const packageJson = await this.getPackageJson(fs, options);
    console.debug('[npm] packageJson', packageJson);
    const allDependencies = {
      ...(packageJson?.dependencies || {}),
      // ...(packageJson?.devDependencies || {}),
      ...(packageJson?.peerDependencies || {}),
      ...(options?.dependencies || {}),
    };

    const packageJsonHashPath = '/~system/package-json-hash';

    const {dependencies, packageJsonHash} =
      await sandpackClient.resolvePackages(
        options.registryBaseUrl,
        allDependencies,
        fs.readFile(packageJsonHashPath),
      );

    fs.writeFile(packageJsonHashPath, packageJsonHash);
    return dependencies;
  }

  public static async install(fs: FileSystem, options: NPMSpawnOptions) {
    const log = options.reported ?? (() => {});
    log('info', `> npm install`);

    const installTime = measureTime();
    // const restoreTime = measureTime();
    // log('info', `┌ Restoring cache`);
    // // const cacheDir = path.join(cwd, 'node_modules');
    // // await Cache.restoreCache(fs, cacheDir);
    // // await Cache.restoreLockfile(fs, cwd);
    // log('info', `└ Completed in ${restoreTime()}`);

    const nodeModulesPath = path.join('/node_modules');
    const scriptsPath = path.join(nodeModulesPath, '.scripts.json');

    const resolutionTime = measureTime();
    log('info', `┌ Resolution step`);
    const packages = await this.resolveDependencies(fs, options);
    log('info', `└ Completed in ${resolutionTime()}`);

    // Nothing to install
    if (!packages) {
      log('info', `Done in ${installTime()}`);
      return;
    }

    const scripts: Record<string, string> = {
      ...((await Promise.resolve(fs.readFile(scriptsPath))
        .then(JSON.parse)
        .catch(() => ({}))) || {}),
    };

    const fetchTime = measureTime();
    log('info', `┌ Fetch step`);
    await Promise.all(
      Object.entries(packages).map(([packageName, packageVersion]) =>
        requestsQueue.add(async () => {
          const packagePath = path.join(nodeModulesPath, packageName);
          const cachePath = packagePath;

          const existing = await Promise.resolve(
            fs.readFile(`${packagePath}/package.json`),
          ).catch(() => null);
          if (existing) {
            const existingJson = JSON.parse(existing);
            if (existingJson.version === packageVersion) {
              return;
            }
          }

          if (
            await sandpackClient.hasPackageFilesInCache(
              packageName,
              packageVersion,
            )
          ) {
            log(
              'info',
              `│ ${packageName}@npm:${packageVersion} found in the cache`,
            );
          } else {
            log(
              'info',
              `│ ${packageName}@npm:${packageVersion} can't be found in the cache and will be fetched from the remote registry`,
            );
          }

          const files = await sandpackClient.downloadPackageFiles(
            options.registryBaseUrl,
            packageName,
            packageVersion,
          );

          for (const [baseFilePath, fileContent] of Object.entries(files)) {
            const filePath = path.join(cachePath, baseFilePath);
            const string = new TextDecoder().decode(fileContent);
            fs.writeFile(filePath, string);
          }

          // TODO: gather "scripts" from all deps package.json
          const pkgJsonText = await Promise.resolve(
            fs.readFile(path.join(cachePath, 'package.json')),
          ).catch(() => null);
          const pkgJson = pkgJsonText ? JSON.parse(pkgJsonText) : null;
          if (pkgJson && pkgJson.bin) {
            if (typeof pkgJson.bin === 'string') {
              scripts[pkgJson.name] = path.resolve(
                packagePath,
                pkgJson.bin as string,
              );
            } else if (typeof pkgJson.bin === 'object') {
              Object.entries(pkgJson.bin).forEach(([name, bin]) => {
                scripts[name] = path.resolve(packagePath, bin as string);
              });
            }
          } else if (pkgJson && pkgJson.main) {
            scripts[pkgJson.name] = path.resolve(
              packagePath,
              pkgJson.main as string,
            );
          }
        }),
      ),
    );
    // await Cache.saveCache(fs, cacheDir);
    log('info', `└ Completed in ${fetchTime()}`);

    // const linkTime = measureTime();
    // log('info', `┌ Link step`);

    // Store scripts
    this.scriptsMap = scripts;
    fs.writeFile(scriptsPath, JSON.stringify(scripts, null, 2));

    // Link packages
    // for (const [packagePath, cachePath] of dirsToLink) {
    //   await fs.mkdirp(path.dirname(packagePath));
    //   const pkgStats = await fs.stat(packagePath).catch(() => null);
    //   if (pkgStats) {
    //     await fs.unlink(packagePath).catch(() => {});
    //     await fs.rimraf(packagePath).catch(() => {});
    //   }
    //   fs.symlink(cachePath, packagePath);
    // }
    // log('info', `└ Completed in ${linkTime()}`);

    log('info', `Done in ${installTime()}`);
  }

  public static async packageScript(
    fs: FileSystem,
    script: string,
    options: NPMSpawnOptions,
  ) {
    const packageJson = await this.getPackageJson(fs, options);
    const scripts = packageJson?.scripts;
    const scriptPath = scripts?.[script];
    const [cmd, ...args] = scriptPath?.split(' ') || [];
    return {cmd, args};
  }

  // E.g. to found source file for `next` script
  public static async dependencyScripts(cmd: string) {
    const scriptPath = this.scriptsMap[cmd];
    return scriptPath || null;
  }
}

const IDB_DB_DEPENDENCIES = 'ESBUILD-dependencies-cache';
const IDB_STORE_CACHE = 'cache';
const IDB_STORE_LOCK = 'lockfile';
const IDB_STORE_SANDPACK_CDN = 'sandpack-cdn';
const IDB_CACHE_VERSION = 1;

function getDB() {
  return openDB(IDB_DB_DEPENDENCIES, IDB_CACHE_VERSION, {
    upgrade(db) {
      const cache = db.createObjectStore(IDB_STORE_CACHE, {keyPath: 'name'});
      cache.createIndex('lastUsed', 'lastUsed', {unique: false});

      db.createObjectStore(IDB_STORE_LOCK, {keyPath: 'name'});

      db.createObjectStore(IDB_STORE_SANDPACK_CDN, {keyPath: 'request'});
    },
    blocked() {},
    blocking() {},
    terminated() {},
  });
}

const localCache = new Map<string, any>();

const Cache = {
  async isCached(request: string) {
    const db = await getDB();
    const cachedData = await db.get(IDB_STORE_SANDPACK_CDN, request);
    return cachedData && cachedData.data;
  },
  async withCacheData<T, R>(
    request: string,
    getData: () => Promise<T>,
    transform: (data: T) => Promise<R>,
  ): Promise<R> {
    const db = await getDB();
    try {
      const cachedData = await db.get(IDB_STORE_SANDPACK_CDN, request);
      if (cachedData && cachedData.data) {
        return await transform(cachedData.data);
      }
    } catch (error) {
      console.error(
        'Error transforming cached data. Trying to get fresh data...',
        error,
      );
    }

    const data = await getData();
    await db.put(IDB_STORE_SANDPACK_CDN, {request, data});
    return transform(data);
  },
  async withLocalCacheData<T, R>(
    request: string,
    getData: () => Promise<T>,
    transform: (data: T) => Promise<R>,
  ): Promise<R> {
    try {
      const cachedData = localCache.get(request);
      if (cachedData) {
        return await transform(cachedData);
      }
    } catch (error) {
      console.error(
        'Error transforming cached data. Trying to get fresh data...',
        error,
      );
    }

    const data = await getData();
    localCache.set(request, data);
    return transform(data);
  },
  // async savePartialCache(basePath: string, files: Record<string, Buffer>) {
  //   const db = await getDB();
  //   let time = Date.now();
  //   // await db.clear(IDB_STORE_CACHE);
  //   {
  //     const tx = db.transaction(IDB_STORE_CACHE, 'readwrite');
  //     await Promise.all([
  //       ...Object.entries(files).map(([name, data]) =>
  //         data && tx.store.put({
  //           name: path.join(basePath, name),
  //           lastUsed: time,
  //           data,
  //         }).catch(() => {}),
  //       ),
  //       tx.done,
  //     ]);
  //   }
  // },
  // async saveCache(fs: FileSystem, cacheDir: string) {
  //   const files = await Promise.all(
  //     (await fs.readdir(cacheDir))
  //       .map(async name => [
  //         name,
  //         (await fs.readFile(cacheDir + '/' + name).catch(() => null)),
  //       ])
  //   );

  //   const db = await getDB();
  //   let time = Date.now();
  //   // await db.clear(IDB_STORE_CACHE);
  //   {
  //     const tx = db.transaction(IDB_STORE_CACHE, 'readwrite');
  //     // await tx.store.clear();
  //     await Promise.all([
  //       ...files.map(([name, data]) =>
  //         data && tx.store.put({
  //           name,
  //           lastUsed: time,
  //           data,
  //         }).catch(() => {}),
  //       ),
  //       tx.done,
  //     ]);
  //   }
  // },
  // async restoreCache(fs: FileSystem, cacheDir: string) {
  //   await fs.mkdirp(cacheDir);
  //   const db = await getDB();
  //   for (let { name, data } of await db.getAll(IDB_STORE_CACHE)) {
  //     await fs.writeFile(
  //       path.join(cacheDir, name),
  //       Buffer.from(data),
  //       undefined,
  //     );
  //   }
  // },
  // async saveLockfile(fs: FileSystem, baseDir: string) {
  //   const data = await fs.readFile(path.join(baseDir, 'yarn.lock'));

  //   const db = await getDB();
  //   await db.put(IDB_STORE_LOCK, {
  //     name: 'yarn.lock',
  //     data,
  //   });
  // },
  // async restoreLockfile(fs: FileSystem, baseDir: string) {
  //   const db = await getDB();
  //   const result = await db.get(IDB_STORE_LOCK, 'yarn.lock');
  //   if (result) {
  //     await fs.writeFile(path.join(baseDir, 'yarn.lock'), Buffer.from(result.data), undefined);
  //   }
  // },
};
