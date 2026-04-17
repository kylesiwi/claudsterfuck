import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const ROUTES_DIR = path.join(PROJECT_ROOT, "routes");
export const FRAMEWORKS_DIR = path.join(PROJECT_ROOT, "frameworks");
export const PROMPTS_DIR = path.join(PROJECT_ROOT, "prompts", "providers");

export function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

export function routePath(routeName) {
  return path.join(ROUTES_DIR, `${routeName}.json`);
}

export function routeExists(routeName) {
  if (!routeName) {
    return false;
  }

  return fs.existsSync(routePath(routeName));
}

export function loadRouteProfile(routeName) {
  return readJson(ensureExists(routePath(routeName), "Route profile"));
}

export const loadRoute = loadRouteProfile;

export function loadRoutes() {
  return fs
    .readdirSync(ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => loadRouteProfile(path.basename(entry.name, ".json")));
}

export function listRouteNames() {
  if (!fs.existsSync(ROUTES_DIR)) {
    return [];
  }

  return fs
    .readdirSync(ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/i, ""))
    .sort((left, right) => left.localeCompare(right));
}

export function frameworkPath(relativePath) {
  return path.join(FRAMEWORKS_DIR, relativePath);
}

export function providerPromptPath(provider) {
  return path.join(PROMPTS_DIR, provider, "worker-base.md");
}

export function ensureExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return filePath;
}
