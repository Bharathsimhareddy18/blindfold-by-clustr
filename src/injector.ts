import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { parse } from 'dotenv';

/**
 * A mapping of environment variable names to their secret values produced by
 * parsing a vaulted `.env` file with {@link https://www.npmjs.com/package/dotenv | dotenv}.
 */
export type SecretsMap = Record<string, string>;

/**
 * Read the vaulted `.env` file, parse every key-value pair, and push them
 * into the VS Code terminal environment so that integrated terminals and
 * tasks inherit the real secrets at process creation time.
 *
 * The collection's `persistent` flag is set to `false` so that VS Code does
 * not independently cache the injected values — Blindfold owns their entire
 * lifecycle.
 *
 * @param vaultPath      Absolute path to the vaulted `.env` file.
 * @param envCollection  The extension's terminal-environment collection
 *                       obtained from {@link vscode.ExtensionContext.environmentVariableCollection}.
 * @returns              The parsed secrets, keyed by variable name.
 * @throws               `NodeJS.ErrnoException` if the vault file cannot be read.
 */
export async function injectIntoTerminals(
	vaultPath: string,
	envCollection: vscode.GlobalEnvironmentVariableCollection,
): Promise<SecretsMap> {
	const content: string = await fs.readFile(vaultPath, 'utf-8');
	const secrets: SecretsMap = parse(content);

	// Do not let VS Code persist these values independently — Blindfold
	// manages the full lifecycle via workspaceState crash recovery.
	envCollection.persistent = false;

	for (const [key, value] of Object.entries(secrets)) {
		envCollection.replace(key, value);
	}

	return secrets;
}

/**
 * Remove every environment variable previously injected by Blindfold from
 * the terminal environment collection.
 *
 * @param envCollection  The same collection that was passed to
 *                       {@link injectIntoTerminals}.
 */
export function clearTerminalInjection(
	envCollection: vscode.GlobalEnvironmentVariableCollection,
): void {
	envCollection.clear();
}

/**
 * A {@link vscode.DebugConfigurationProvider} that merges vaulted secrets
 * into every debug session's `env` block.
 *
 * Secrets are only injected for keys the user has **not** already set in
 * their `launch.json` — explicit user configuration always takes precedence.
 *
 * The provider is registered with debug type `'*'` so it covers Node.js,
 * Python, Go, and any other debugger the workspace may use.
 */
export class BlindfoldDebugConfigurationProvider
	implements vscode.DebugConfigurationProvider
{
	/** Parsed vault secrets to inject into debug sessions. */
	private readonly secrets: SecretsMap;

	/**
	 * @param secrets  The parsed vault secrets (from {@link injectIntoTerminals}).
	 */
	public constructor(secrets: SecretsMap) {
		this.secrets = secrets;
	}

	/**
	 * Called by VS Code to resolve a debug configuration before launch.
	 *
	 * Merges vaulted secrets into `config.env` for keys not already present.
	 * Returns the modified configuration.
	 */
	public resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		debugConfiguration: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		this.mergeSecrets(debugConfiguration);
		return debugConfiguration;
	}

	/**
	 * Called by VS Code after `${…}` variable substitution in the debug
	 * configuration.  Behaves identically to {@link resolveDebugConfiguration}
	 * so secrets are injected regardless of which resolution path VS Code takes.
	 */
	public resolveDebugConfigurationWithSubstitutedVariables(
		_folder: vscode.WorkspaceFolder | undefined,
		debugConfiguration: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		this.mergeSecrets(debugConfiguration);
		return debugConfiguration;
	}

	/**
	 * Merge vaulted secrets into `config.env`, skipping any key the user
	 * has already defined in their launch configuration.
	 */
	private mergeSecrets(debugConfiguration: vscode.DebugConfiguration): void {
		if (!debugConfiguration.env) {
			debugConfiguration.env = {};
		}
		const env: Record<string, string> = debugConfiguration.env as Record<string, string>;
		for (const [key, value] of Object.entries(this.secrets)) {
			if (!(key in env)) {
				env[key] = value;
			}
		}
	}
}
