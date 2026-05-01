import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export function findProjectRoot(startPath: string): string {
  let current = startPath;
  while (true) {
    if (existsSync(join(current, ".pi"))) {
      return current;
    }
    if (current === "/") break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startPath;
}

export function isExternalPath(filePath: string, projectRoot: string): boolean {
  const absRoot = projectRoot.startsWith("/") ? projectRoot : join(process.cwd(), projectRoot);
  const resolvedPath = resolve(filePath);
  return !resolvedPath.startsWith(absRoot + "/") && resolvedPath !== absRoot;
}

export function normalizePathForMatching(filePath: string, projectRoot: string): string {
  let normalized = filePath;

  if (normalized.startsWith("~")) {
    normalized = join(process.env.HOME ?? "/home", normalized.slice(1));
  }

  if (normalized.startsWith("/")) {
    const absRoot = projectRoot.startsWith("/") ? projectRoot : join(process.cwd(), projectRoot);
    if (normalized.startsWith(absRoot + "/") || normalized === absRoot) {
      normalized = normalized.slice(absRoot.length + 1) || ".";
    }
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized || ".";
}
