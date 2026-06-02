/**
 * Multi-vector canary token provisioning engine.
 *
 * Fetches both an AWS API key trap and an HTTP web bug URL trap from
 * canarytokens.org concurrently, merging them into a single honeypot
 * block for the .env decoy.  Any autonomous AI agent that scrapes the
 * decoy and attempts to use the credentials or access the tracking URL
 * triggers a deterministic network alert to the user's email.
 *
 * Design principle: **fail open**.  Every network failure (offline, DNS
 * resolution error, timeout, non-2xx response, missing response fields) is
 * silently swallowed at the call-site.  The Blindfold shield still activates
 * — just without the affected canary appended.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of a successful response from the canarytokens.org /generate endpoint.
 * All fields are optional because the response varies by token kind.
 */
interface CanaryTokenResponse {
    readonly access_key_id?: string;
    readonly secret_access_key?: string;
    readonly url?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canarytokens.org generation endpoint. */
const CANARY_ENDPOINT: string = 'https://canarytokens.org/generate';

/**
 * Headers required to bypass Cloudflare WAF bot-protection on the canary
 * token generation endpoint.  Without a realistic User-Agent the request
 * is rejected at the edge before reaching the application.
 */
const CANARY_HEADERS: Record<string, string> = {
    'Accept': 'application/json',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded',
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Request a single canary token of the given kind from canarytokens.org.
 *
 * This is a low-level transport helper.  It handles the HTTP round-trip,
 * response parsing, and error logging.  Callers receive the raw parsed JSON
 * object or `null` when the request fails for any reason.
 *
 * @param kind  Token type to request — `'aws'` for AWS credential keys,
 *              `'http'` for a web bug / tracking URL.
 * @param email Destination email address for breach alerts.
 * @param memo  Human-readable memo attached to the token for traceability.
 * @returns     The parsed JSON response body, or `null` on failure.
 */
async function fetchCanaryToken(
    kind: 'aws' | 'http',
    email: string,
    memo: string,
): Promise<CanaryTokenResponse | null> {
    try {
        const body: URLSearchParams = new URLSearchParams({
            kind,
            email,
            memo,
        });

        const response: Response = await fetch(CANARY_ENDPOINT, {
            method: 'POST',
            headers: CANARY_HEADERS,
            body: body.toString(),
        });

        if (!response.ok) {
            const errorText: string = await response.text();
            console.error(
                `[Blindfold] Canary HTTP ${response.status} (kind=${kind}):`,
                errorText,
            );
            return null;
        }

        const data: unknown = await response.json();
        return data as CanaryTokenResponse;
    } catch (error: unknown) {
        console.error(
            `[Blindfold] Canary Network Exception (kind=${kind}):`,
            error,
        );
        return null;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Provision both AWS credential and HTTP web bug canary traps concurrently
 * and return them as a formatted .env block ready to append to the decoy file.
 *
 * The returned block is placed under a `# --- SECURITY HONEYPOT ---` header
 * and contains:
 *
 * - **AWS trap**: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` variables
 *   populated with real AWS-style keys registered as canary tokens.  Any use
 *   of these keys (e.g. `aws sts get-caller-identity`) fires an alert.
 *
 * - **HTTP trap**: `SUPABASE_URL` and `STRIPE_WEBHOOK_SECRET` variables both
 *   pointing to the same canary tracking URL.  Either service hitting the URL
 *   (common targets for credential-stuffing tooling) triggers an alert.
 *
 * Both requests are fired concurrently via `Promise.all`.  Individual
 * failures are silently swallowed (fail-open).  If *both* endpoints fail,
 * an empty string is returned — the shield still activates without canaries.
 *
 * @param email         Email address to receive breach alerts.
 * @param workspaceRoot Absolute path to the workspace root directory,
 *                      included in the canary memo for traceability.
 * @returns             A formatted .env block with honeypot variables,
 *                      or an empty string if both endpoints failed.
 */
export async function generateCanaryTraps(
    email: string,
    workspaceRoot: string,
): Promise<string> {
    const memo: string =
        `Blindfold Breach Alert: Workspace ${workspaceRoot}`;

    const [awsResult, httpResult]: [
        CanaryTokenResponse | null,
        CanaryTokenResponse | null,
    ] = await Promise.all([
        fetchCanaryToken('aws', email, memo),
        fetchCanaryToken('http', email, memo),
    ]);

    const blocks: string[] = [];

    // -------- AWS credential trap --------
    if (awsResult !== null) {
        const accessKey: string | undefined = awsResult.access_key_id;
        const secretKey: string | undefined = awsResult.secret_access_key;
        if (accessKey !== undefined && secretKey !== undefined) {
            blocks.push(
                `AWS_ACCESS_KEY_ID=${accessKey}`,
                `AWS_SECRET_ACCESS_KEY=${secretKey}`,
            );
        }
    }

    // -------- HTTP web bug trap --------
    // Map the canary tracking URL to two high-value service endpoints.
    // Both variables hold the same canary URL — if either is exfiltrated
    // and accessed the canary fires an alert.
    if (httpResult !== null) {
        const trackingUrl: string | undefined = httpResult.url;
        if (trackingUrl !== undefined) {
            blocks.push(
                `SUPABASE_URL=${trackingUrl}`,
                `STRIPE_WEBHOOK_SECRET=${trackingUrl}`,
            );
        }
    }

    if (blocks.length === 0) {
        return '';
    }

    return '\n# --- SECURITY HONEYPOT ---\n' + blocks.join('\n') + '\n';
}
