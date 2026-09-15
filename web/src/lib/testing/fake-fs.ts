import * as path from "path";
import type { PluginFsLike } from "../plugins";

/** In-memory fs: `files` maps absolute path → content; directories are implied. */
export function fakeFs(files: Record<string, string>): PluginFsLike {
  const normalized = new Map(Object.entries(files).map(([p, c]) => [path.normalize(p), c]));
  const dirs = new Set<string>();
  for (const p of normalized.keys()) {
    let dir = path.dirname(p);
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {
    existsSync: (p) => normalized.has(path.normalize(p)) || dirs.has(path.normalize(p)),
    readFileSync: (p) => {
      const content = normalized.get(path.normalize(p));
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    readdirSync: (p) => {
      const base = path.normalize(p);
      const names = new Set<string>();
      for (const candidate of [...normalized.keys(), ...dirs]) {
        if (path.dirname(candidate) === base && candidate !== base) names.add(path.basename(candidate));
      }
      return Array.from(names);
    },
    statSync: (p) => {
      const n = path.normalize(p);
      return { isDirectory: () => dirs.has(n), isFile: () => normalized.has(n) };
    },
  };
}

/** Mutable in-memory fs with write support (memory tests). `files` is shared and mutated. */
export function fakeWritableFs(files: Record<string, string>) {
  const norm = (p: string) => path.normalize(p);
  const dirs = new Set<string>();
  const addDirs = (p: string) => {
    let dir = path.dirname(p);
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  };
  for (const p of Object.keys(files)) addDirs(norm(p));
  const has = (p: string) => Object.prototype.hasOwnProperty.call(files, norm(p));
  return {
    existsSync: (p: string) => has(p) || dirs.has(norm(p)),
    readFileSync: (p: string) => {
      if (!has(p)) throw new Error(`ENOENT: ${p}`);
      return files[norm(p)];
    },
    readdirSync: (p: string) => {
      const base = norm(p);
      const names = new Set<string>();
      for (const candidate of [...Object.keys(files).map(norm), ...dirs]) {
        if (path.dirname(candidate) === base && candidate !== base) names.add(path.basename(candidate));
      }
      return Array.from(names);
    },
    statSync: (p: string) => ({ isDirectory: () => dirs.has(norm(p)), isFile: () => has(p) }),
    writeFileSync: (p: string, data: string) => {
      files[norm(p)] = data;
      addDirs(norm(p));
    },
    mkdirSync: (p: string) => {
      const n = norm(p);
      dirs.add(n);
      addDirs(path.join(n, "x"));
    },
    unlinkSync: (p: string) => {
      delete files[norm(p)];
    },
  };
}
