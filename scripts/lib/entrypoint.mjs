import path from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectExecution(importMetaUrl) {
  if (!process.argv[1]) {
    return false;
  }

  const currentFile = path.resolve(fileURLToPath(importMetaUrl));
  const invokedFile = path.resolve(process.argv[1]);
  return currentFile === invokedFile;
}
