import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Workspace-state keys (persisted across window reloads for crash recovery)
// ---------------------------------------------------------------------------

const STATE_KEY_ACTIVE: string = 'blindfold.active';
const STATE_KEY_VAULT_PATH: string = 'blindfold.vaultPath';

// ---------------------------------------------------------------------------
// .gitignore protection
// ---------------------------------------------------------------------------

/**
 * Ensure that `.env` is listed in the workspace `.gitignore`.
 *
 * Creates the file if it does not exist; appends the entry if it is missing.
 * Errors are handled internally because this is a best-effort guard on a
 * non-critical path.
 */
export async function ensureGitignore(workspaceRoot: string): Promise<void> {
    try {
        const gitignorePath: string = path.join(workspaceRoot, '.gitignore');

        let content: string;
        try {
            content = await fs.readFile(gitignorePath, 'utf-8');
        } catch (error: unknown) {
            const nodeError: NodeJS.ErrnoException = error as NodeJS.ErrnoException;
            if (nodeError.code === 'ENOENT') {
                // .gitignore does not exist — create one with .env listed.
                await fs.writeFile(gitignorePath, '.env\n', 'utf-8');
                return;
            }
            // Non-ENOENT errors (permissions, etc.) are non-critical.
            return;
        }

        // Check whether .env is already listed as an entry.
        if (!/\.env/m.test(content)) {
            await fs.appendFile(gitignorePath, '\n.env\n', 'utf-8');
        }
    } catch {
        // Last-resort safety net — this function is best-effort.
    }
}

// ---------------------------------------------------------------------------
// Workspace-state management (crash-recovery persistence)
// ---------------------------------------------------------------------------

/**
 * Persist the active vault state to the extension's workspace storage.
 *
 * Used immediately after a successful vault operation so that crash
 * recovery can re-inject secrets on the next extension activation.
 */
export async function lockVaultState(
    context: vscode.ExtensionContext,
    vaultPath: string,
): Promise<void> {
    await context.workspaceState.update(STATE_KEY_ACTIVE, true);
    await context.workspaceState.update(STATE_KEY_VAULT_PATH, vaultPath);
}

/**
 * Remove all Blindfold state from workspace storage.
 *
 * Called when the shield is deliberately deactivated by the user.
 */
export async function clearVaultState(
    context: vscode.ExtensionContext,
): Promise<void> {
    await context.workspaceState.update(STATE_KEY_ACTIVE, undefined);
    await context.workspaceState.update(STATE_KEY_VAULT_PATH, undefined);
}

/**
 * Attempt to recover from a previous crash where the shield was active.
 *
 * Returns the vault path if:
 *   1. workspaceState says the shield was active, AND
 *   2. workspaceState has a stored vault path (string), AND
 *   3. the vault file still exists on disk (passed fs.access).
 *
 * If the state says active but the vault file is gone (manually deleted,
 * drive unmounted, etc.), the state is cleaned up automatically so that
 * crash recovery does not repeatedly fail on every window reload.
 *
 * @returns The vault path for re-injection, or `null` if no recovery is needed.
 */
export async function recoverVaultState(
    context: vscode.ExtensionContext,
): Promise<string | null> {
    const wasActive: boolean | undefined = context.workspaceState.get<boolean>(
        STATE_KEY_ACTIVE,
    );
    const vaultPath: string | undefined = context.workspaceState.get<string>(
        STATE_KEY_VAULT_PATH,
    );

    if (wasActive !== true || typeof vaultPath !== 'string') {
        return null;
    }

    try {
        await fs.access(vaultPath);
        return vaultPath;
    } catch {
        // Vault file no longer exists — purge the stale state so that
        // crash recovery does not keep re-entering this path on every
        // window reload.
        await context.workspaceState.update(STATE_KEY_ACTIVE, undefined);
        await context.workspaceState.update(STATE_KEY_VAULT_PATH, undefined);
        return null;
    }
}
