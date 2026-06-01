import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	vaultEnvFile,
	restoreEnvFile,
	getVaultPath,
	type VaultResult,
} from './vault';
import {
	injectIntoTerminals,
	clearTerminalInjection,
	BlindfoldDebugConfigurationProvider,
	type SecretsMap,
} from './injector';
import {
    ensureGitignore,
    lockVaultState,
    clearVaultState,
    recoverVaultState,
} from './recovery';

// ---------------------------------------------------------------------------
// Status-bar labels
// ---------------------------------------------------------------------------

const STATUS_OFF: string = '$(eye) Blindfold: OFF';
const STATUS_ACTIVE: string = '$(eye-closed) Blindfold: ACTIVE';

// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------

/**
 * Handle returned by {@link vscode.debug.registerDebugConfigurationProvider}.
 * Stored at module scope so {@link deactivate} can dispose it on extension
 * unload without restoring the vaulted file (secrets stay vaulted across
 * window reloads — crash recovery re-injects them).
 */
let debugProviderDisposable: vscode.Disposable | undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the absolute filesystem path of the first workspace folder, or
 * `undefined` when no workspace is open.
 */
function getWorkspaceRoot(): string | undefined {
	const folders: readonly vscode.WorkspaceFolder[] | undefined =
		vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return undefined;
	}
	return folders[0].uri.fsPath;
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

/**
 * Called by VS Code when the extension is activated (on startup finished, per
 * the `onStartupFinished` activation event).
 *
 * Responsibilities:
 * 1. Create and show the status-bar toggle item.
 * 2. Recover from a previous crash by re-injecting vaulted secrets.
 * 3. Register the `blindfold.toggleShield` command.
 * 4. Ensure `.env` is listed in the workspace `.gitignore`.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// -------- Runtime state (closure-scoped, lives for the session) --------
	let isActive: boolean = false;
	let vaultPath: string | undefined;

	// -------- Status-bar item ----------------------------------------------
	const statusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	statusBarItem.command = 'blindfold.toggleShield';
	statusBarItem.text = STATUS_OFF;
	statusBarItem.tooltip = 'Click to toggle Blindfold shield';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// -------- Internal helpers (close over runtime state) ------------------

	/**
	 * Vault the workspace `.env`, inject secrets into terminals and debug
	 * sessions, persist state, and update the status bar.
	 */
	async function activateShield(): Promise<void> {
		const workspaceRoot: string | undefined = getWorkspaceRoot();
		if (!workspaceRoot) {
			void vscode.window.showErrorMessage(
				'Blindfold requires an open workspace folder.',
			);
			return;
		}

		const envPath: string = path.join(workspaceRoot, '.env');

		// If the workspace has no .env at all, offer to create a template.
		try {
			await fs.access(envPath);
		} catch {
			const choice: string | undefined =
				await vscode.window.showInformationMessage(
					'No .env file found in workspace. Create one?',
					'Create .env',
				);
			if (choice === 'Create .env') {
				await fs.writeFile(
					envPath,
					'# Blindfold-managed environment file\n',
					'utf-8',
				);
			} else {
				return;
			}
		}

		const result: VaultResult = await vaultEnvFile(workspaceRoot);
		const secrets: SecretsMap = await injectIntoTerminals(
			result.vaultPath,
			context.environmentVariableCollection,
		);

		// Register the debug-configuration provider for every debug type so
		// secrets flow into Node.js, Python, Go, and any other debugger.
		const provider: BlindfoldDebugConfigurationProvider =
			new BlindfoldDebugConfigurationProvider(secrets);
		debugProviderDisposable = vscode.debug.registerDebugConfigurationProvider(
			'*',
			provider,
		);

		// Persist state for crash recovery.
		await lockVaultState(context, result.vaultPath);

		isActive = true;
		vaultPath = result.vaultPath;
		statusBarItem.text = STATUS_ACTIVE;

		void vscode.window.showInformationMessage(
			'Blindfold shield active. Secrets air-gapped to vault.',
		);
	}

	/**
	 * Clear terminal injection, dispose the debug provider, restore the
	 * original `.env` from the vault, and update the status bar.
	 */
	async function deactivateShield(): Promise<void> {
		const workspaceRoot: string | undefined = getWorkspaceRoot();
		if (!workspaceRoot) {
			void vscode.window.showErrorMessage(
				'Blindfold requires an open workspace folder.',
			);
			return;
		}

		clearTerminalInjection(context.environmentVariableCollection);

		if (debugProviderDisposable) {
			debugProviderDisposable.dispose();
			debugProviderDisposable = undefined;
		}

		if (vaultPath) {
			await restoreEnvFile(workspaceRoot, vaultPath);
		}

		// Purge persisted state.
		await clearVaultState(context);

		isActive = false;
		vaultPath = undefined;
		statusBarItem.text = STATUS_OFF;

		void vscode.window.showInformationMessage(
			'Blindfold shield deactivated. Secrets restored to workspace.',
		);
	}

	// -------- Crash recovery -----------------------------------------------
	//
	// If the extension process ended while the shield was active (crash,
	// forced quit, etc.) the workspace state still records the vault path.
	// Re-inject secrets so the user doesn't have to toggle manually.

	const recoveredVaultPath: string | null = await recoverVaultState(context);
	if (recoveredVaultPath !== null) {
		const secrets: SecretsMap = await injectIntoTerminals(
			recoveredVaultPath,
			context.environmentVariableCollection,
		);
		const provider: BlindfoldDebugConfigurationProvider =
			new BlindfoldDebugConfigurationProvider(secrets);
		debugProviderDisposable =
			vscode.debug.registerDebugConfigurationProvider('*', provider);

		isActive = true;
		vaultPath = recoveredVaultPath;
		statusBarItem.text = STATUS_ACTIVE;
	}

	// -------- Command registration -----------------------------------------

	const toggleCommand: vscode.Disposable = vscode.commands.registerCommand(
		'blindfold.toggleShield',
		async (): Promise<void> => {
			try {
				if (isActive) {
					await deactivateShield();
				} else {
					await activateShield();
				}
			} catch (err: unknown) {
				const message: string =
					err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(
					`Blindfold toggle failed: ${message}`,
				);
			}
		},
	);
	context.subscriptions.push(toggleCommand);

	// -------- .gitignore protection ----------------------------------------
	//
	// Ensure `.env` is listed in the workspace `.gitignore` so that even if
	// the shield is off the secrets file is never accidentally committed.
	// This runs once per activation and fails silently — it is a best-effort
	// guard, not a critical path.

	{
		const workspaceRoot: string | undefined = getWorkspaceRoot();
		if (workspaceRoot) {
			void ensureGitignore(workspaceRoot);
		}
	}
}

/**
 * Called by VS Code when the extension is deactivated.
 *
 * Disposes the debug-configuration provider if one is registered, but does
 * **not** restore vaulted files — secrets stay vaulted across window reloads
 * and are re-injected by crash recovery on the next activation.
 */
export function deactivate(): void {
	if (debugProviderDisposable) {
		debugProviderDisposable.dispose();
		debugProviderDisposable = undefined;
	}
}
