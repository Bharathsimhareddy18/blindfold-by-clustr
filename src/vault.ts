import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

/**
 * Root directory for the Blindfold vault on disk.
 * All vaulted secrets live under ~/.secrets/blindfold/
 */
const VAULT_ROOT: string = path.join(os.homedir(), '.secrets', 'blindfold');

/**
 * Content written to the workspace as a decoy after the real .env is vaulted.
 * Autonomous tooling that reads this file will see inert placeholder values,
 * poisoning any context the tool assembles from disk.
 */
const DECOY_CONTENT: string = 'BLINDFOLD_ACTIVE=true\n# Decoy Configuration\n';

/**
 * Maximum bytes to read from a .env file when checking whether it is already
 * a decoy. The decoy marker appears in the first line so a small read is
 * sufficient and avoids loading large files into memory.
 */
const DECOY_GUARD_READ_LENGTH: number = 128;

/**
 * Returned by {@link vaultEnvFile} after the real .env has been moved into the
 * vault and replaced with a decoy in the workspace.
 */
export interface VaultResult {
    /** Absolute path to the vaulted .env inside ~/.secrets/blindfold/ */
    readonly vaultPath: string;
    /** The workspace root that was vaulted (same value passed in) */
    readonly workspaceRoot: string;
}

/**
 * Compute the SHA-256 hex digest of the workspace root path.
 *
 * The same workspace always maps to the same vault file, making the vault
 * path deterministic and idempotent across sessions.
 */
export function hashWorkspaceRoot(workspaceRoot: string): string {
    return crypto.createHash('sha256').update(workspaceRoot).digest('hex');
}

/**
 * Return the absolute path where a workspace's .env would be vaulted.
 *
 * Pure function — does not touch the filesystem.
 */
export function getVaultPath(workspaceRoot: string): string {
    const hash: string = hashWorkspaceRoot(workspaceRoot);
    return path.join(VAULT_ROOT, `${hash}.env`);
}

/**
 * Check whether the .env file at `envPath` is already a Blindfold decoy.
 *
 * Reads only the first {@link DECOY_GUARD_READ_LENGTH} bytes and looks for
 * the marker string `BLINDFOLD_ACTIVE=true`.  If the file cannot be read
 * (e.g. it does not exist) the function returns `false` so the caller can
 * proceed with vaulting.
 */
async function isDecoyFile(envPath: string): Promise<boolean> {
    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(envPath, 'r');
        const buffer: Buffer = Buffer.alloc(DECOY_GUARD_READ_LENGTH);
        const { bytesRead } = await handle.read(buffer, 0, DECOY_GUARD_READ_LENGTH, 0);
        const head: string = buffer.toString('utf-8', 0, bytesRead);
        return head.includes('BLINDFOLD_ACTIVE=true');
    } catch {
        return false;
    } finally {
        if (handle !== undefined) {
            await handle.close();
        }
    }
}

/**
 * Move the workspace `.env` into the OS-level vault and replace it with a
 * context-poisoned decoy.
 *
 * **Safety guard:** if the workspace `.env` is already a decoy the
 * operation is skipped to prevent overwriting the real secrets that are
 * already stored in the vault.  In that case the existing vault path is
 * returned so the caller can proceed with injection.
 *
 * @param workspaceRoot  Absolute path to the workspace root directory.
 * @returns              The vault path and workspace root for downstream injection.
 * @throws               `NodeJS.ErrnoException` on I/O failures (ENOENT, EACCES, …).
 */
export async function vaultEnvFile(workspaceRoot: string): Promise<VaultResult> {
    const envPath: string = path.join(workspaceRoot, '.env');
    const vaultPath: string = getVaultPath(workspaceRoot);

    // Guard: if the workspace .env is already a decoy, the real secrets are
    // already in the vault — skip to avoid overwriting them with decoy content.
    if (await isDecoyFile(envPath)) {
        return { vaultPath, workspaceRoot };
    }

    // Ensure the vault root directory exists (no-op if already present).
    await fs.mkdir(VAULT_ROOT, { recursive: true });

    // Move the real .env into the vault. Handle cross-device EXDEV errors.
    try {
        await fs.rename(envPath, vaultPath);
    } catch (error: any) {
        if (error.code === 'EXDEV') {
            await fs.copyFile(envPath, vaultPath);
            await fs.unlink(envPath);
        } else {
            throw error;
        }
    }

    // Write the context-poisoned decoy back into the workspace so autonomous
    // tooling that reads the expected filename sees only inert values.
    await fs.writeFile(envPath, DECOY_CONTENT, 'utf-8');

    return { vaultPath, workspaceRoot };
}

/**
 * Restore the vaulted `.env` back to the workspace, reversing a previous
 * {@link vaultEnvFile} call.
 *
 * @param workspaceRoot  Absolute path to the workspace root directory.
 * @param vaultPath      Absolute path to the vaulted .env file.
 * @throws               `NodeJS.ErrnoException` on I/O failures.
 */
export async function restoreEnvFile(workspaceRoot: string, vaultPath: string): Promise<void> {
    const envPath: string = path.join(workspaceRoot, '.env');
    
    try {
        await fs.rename(vaultPath, envPath);
    } catch (error: any) {
        if (error.code === 'EXDEV') {
            await fs.copyFile(vaultPath, envPath);
            await fs.unlink(vaultPath);
        } else {
            throw error;
        }
    }
}