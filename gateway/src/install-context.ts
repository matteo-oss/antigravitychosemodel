import { USER_DATA_DIR } from './data-paths.js';
/**
 * Agent Context Installer
 *
 * Installs agent-context.md to a global well-known location (~/.antigravity/)
 * so the LLM agent can always find the operating manual at a stable path
 * regardless of where the proxy is running from.
 *
 * ## Design
 *
 * - **Once-only via content hash**: A `.context-installed` marker file stores
 *   the SHA-256 hash of the source file. On each startup the marker hash is
 *   compared against the current source; if they match, no copy occurs. This
 *   means a proxy upgrade that updates agent-context.md will automatically
 *   re-install it, but repeated restarts of the same build are zero-cost.
 *
 * - **Atomic write**: The destination file is written to a temporary path
 *   first, then renamed into place. This prevents partial/corrupt files on
 *   power loss or crash.
 *
 * - **Cross-platform**: Uses `os.homedir()` which resolves correctly on
 *   Linux (~/.antigravity), macOS (~/.antigravity), and Windows
 *   (C:\Users\<name>\.antigravity).
 *
 * - **Graceful failure**: If the source file is missing, permissions are
 *   wrong, or the home directory is unavailable, the installer logs a warning
 *   and returns null. The proxy continues to work using the source location.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

/** The global directory name placed inside the user's home directory */
const GLOBAL_DIR_NAME = '.antigravity';

/** Filename for the installed agent-context.md */
const INSTALLED_FILENAME = 'agent-context.md';

/** Filename for the content-hash marker (sidecar) */
const MARKER_FILENAME = '.context-installed';

/**
 * Resolve the global install directory.
 * Same path on all platforms: ~/.antigravity
 */
function getGlobalDir(): string {
  return USER_DATA_DIR;
}

/**
 * Resolve the full path to the installed agent-context.md.
 */
function getDestPath(): string {
  return path.join(getGlobalDir(), INSTALLED_FILENAME);
}

/**
 * Resolve the full path to the content-hash marker file.
 */
function getMarkerPath(): string {
  return path.join(getGlobalDir(), MARKER_FILENAME);
}

/**
 * Compute the SHA-256 hex digest of a file.
 * Returns null if the file cannot be read.
 */
function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Install agent-context.md to the global location (~/.antigravity/).
 *
 * Decision logic:
 *   1. Source missing → warn, return null (proxy uses source path as fallback)
 *   2. Marker exists AND hash matches source AND dest file exists → skip (return dest path)
 *   3. Otherwise → copy atomically to dest, write marker, return dest path
 *
 * @param sourcePath - Absolute path to the source agent-context.md
 * @returns The installed path, or null if installation failed/skipped
 */
export function installAgentContext(sourcePath: string): string | null {
  // ── Step 1: Verify source exists ─────────────────────────────────────
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    logger.warn(`[install-context] Source not found at "${sourcePath}" — skipping install`);
    return null;
  }

  const destPath = getDestPath();
  const markerPath = getMarkerPath();
  const globalDir = getGlobalDir();

  // ── Step 2: Compute source hash ──────────────────────────────────────
  const sourceHash = hashFile(sourcePath);
  if (!sourceHash) {
    logger.warn(`[install-context] Cannot read source file "${sourcePath}" — skipping install`);
    return null;
  }

  // ── Step 3: Check if already installed with the same content ─────────
  try {
    const destExists = fs.existsSync(destPath);
    const markerExists = fs.existsSync(markerPath);

    if (destExists && markerExists) {
      const markerHash = fs.readFileSync(markerPath, 'utf-8').trim();
      if (markerHash === sourceHash) {
        logger.debug(`[install-context] Already installed at "${destPath}" (hash matches)`);
        return destPath;
      }
    }
  } catch {
    // Ignore marker read errors — proceed with (re)install below
  }

  // ── Step 4: Install / update ─────────────────────────────────────────
  try {
    // Create global directory (recursive — safe if already exists)
    fs.mkdirSync(globalDir, { recursive: true });

    // Write to a temporary file first, then atomic rename.
    // This prevents a crash mid-write from leaving a partial file.
    const tmpPath = path.join(globalDir, `${INSTALLED_FILENAME}.tmp.${process.pid}`);
    const sourceContent = fs.readFileSync(sourcePath);
    fs.writeFileSync(tmpPath, sourceContent);
    fs.renameSync(tmpPath, destPath);

    // Write marker with the source hash
    fs.writeFileSync(markerPath, sourceHash, 'utf-8');

    logger.info(`[install-context] Installed agent-context.md at "${destPath}"`);

    // Set env var so downstream consumers find the global path
    process.env.AGENT_CONTEXT_PATH = destPath;

    return destPath;
  } catch (err: any) {
    logger.warn(`[install-context] Failed to install at "${destPath}": ${err.message}`);
    return null;
  }
}
