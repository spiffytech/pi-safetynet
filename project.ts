import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

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
  if (!filePath.startsWith("/")) return false;
  const absRoot = projectRoot.startsWith("/") ? projectRoot : join(process.cwd(), projectRoot);
  return !filePath.startsWith(absRoot + "/") && filePath !== absRoot;
}

export function getApprovalsFilePath(cwd: string): string {
  const root = findProjectRoot(cwd);
  return join(root, ".pi", "extensions", "spfy", "approvals.json");
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
