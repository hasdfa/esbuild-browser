import * as comlink from 'comlink';

export interface ProjectFile {
  contents: string;
  isEntry?: boolean;
  jsEntry?: boolean;
}

export type ProjectFiles = Record<string, ProjectFile>;

export interface BaseFileSystemManager {
  tmpDirPath: string;
  cwd: () => string;
  chdir: (path: string) => void;
  exists: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  writeFile: (path: string, contents: string) => void;
  appendFile: (path: string, contents: string) => void;
  readFile: (path: string) => string;
  deleteFile: (path: string) => void;
  setFiles: (files: ProjectFiles) => void;
  readdir: (path: string) => string[];
  rmdir: (path: string) => void;
}

export type SerializableFileSystemManager = ReturnType<
  FileSystemManager['toSerializable']
>;

function absPath(path: string) {
  return path.startsWith('/') ? path.slice(1) : path;
}

export class FileSystemManager implements BaseFileSystemManager {
  private projectFiles: ProjectFiles = {
    // [`${this.tmpDirPath}/.gitkeep`]: { contents: '' },
  };

  private currentWorkingDirectory: string = '/app';

  constructor(private readonly remote?: BaseFileSystemManager) {}

  public readonly cwd = () => {
    return this.currentWorkingDirectory;
  };

  public get tmpDirPath() {
    return '/tmp';
  }

  public readonly chdir = (path: string) => {
    const targetPath = absPath(path);
    this.currentWorkingDirectory = targetPath;
    this.remote?.chdir(targetPath);
  };

  public get files(): ProjectFiles {
    return this.projectFiles;
  }

  public get rawFiles(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.projectFiles).map(([key, value]) => [
        key,
        value.contents,
      ]),
    );
  }

  public get fileNames() {
    return Object.keys(this.projectFiles);
  }

  public readonly exists = (path: string) => {
    const targetPath = absPath(path);
    return targetPath in this.projectFiles;
  };

  public readonly isDirectory = (path: string) => {
    const targetPath = absPath(path);
    return this.fileNames.some(
      file =>
        file.startsWith(targetPath) && file.length > targetPath.length + 1,
    );
  };

  public readonly setFiles = (files: ProjectFiles) => {
    for (const [path, file] of Object.entries(files)) {
      const targetPath = absPath(path);
      this.projectFiles[targetPath] = {
        ...(this.projectFiles[targetPath] || {}),
        ...file,
      };
    }

    this.remote?.setFiles(files);
  };

  public readonly writeFile = (path: string, contents: string) => {
    const targetPath = absPath(path);
    this.projectFiles[targetPath] = {
      ...(this.projectFiles[targetPath] || {}),
      contents,
    };
    this.remote?.writeFile(targetPath, contents);
  };

  public readonly appendFile = (path: string, contents: string) => {
    const targetPath = absPath(path);
    this.writeFile(
      targetPath,
      (this.projectFiles[targetPath]?.contents || '') + contents,
    );
    this.remote?.appendFile(targetPath, contents);
  };

  public readonly deleteFile = (path: string) => {
    delete this.projectFiles[absPath(path)];
  };

  public readonly readFile = (path: string) => {
    return this.projectFiles[absPath(path)]?.contents || '';
  };

  public readonly readdir = (path: string) => {
    const targetPath = absPath(path);
    return this.fileNames.filter(file => file.startsWith(targetPath));
  };

  public readonly rmdir = (path: string) => {
    const files = this.readdir(path);
    for (const file of files) {
      this.deleteFile(file);
    }
  };

  public toSerializable() {
    const self = this;
    return {
      fs__cwd: self.cwd,
      fs__chdir: self.chdir,
      fs__exists: self.exists,
      fs__readdir: self.readdir,
      fs__isDirectory: self.isDirectory,
      fs__writeFile: self.writeFile,
      fs__appendFile: self.appendFile,
      fs__readFile: self.readFile,
      fs__deleteFile: self.deleteFile,
      fs__setFiles: self.setFiles,
    };
  }

  public static fromFiles(
    files: ProjectFiles,
    remoteFS?: BaseFileSystemManager,
  ) {
    const fs = new FileSystemManager(remoteFS);
    fs.setFiles(files);
    return fs;
  }

  public static fromSerializedRemote(
    remote: comlink.Remote<SerializableFileSystemManager>,
  ) {
    const fs = new FileSystemManager(unserializeFS(remote));
    return fs;
  }
}

function unserializeFS(
  fs: comlink.Remote<SerializableFileSystemManager>,
): BaseFileSystemManager {
  return new Proxy(
    {},
    {
      get(target: any, prop: string) {
        return (fs as any)[`fs__${prop}`];
      },
    },
  ) as unknown as BaseFileSystemManager;
}
