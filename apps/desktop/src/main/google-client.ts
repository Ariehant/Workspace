import type { GoogleClientConfig } from '@workspace/core';

export type GoogleClientSource = 'environment' | 'own' | 'built-in';

const constant = (value: () => string): string => {
  try {
    return value().trim();
  } catch {
    // Not defined: a run outside the bundle (unit tests).
    return '';
  }
};

/**
 * Workspace's own Google client (and the Picker's API key and project number), built in from the
 * GOOGLE_* secrets (docs/google-oauth.md). Null in builds without them. A desktop client's secret
 * and the Picker's browser key aren't secret in an installed app; sign-in uses PKCE.
 */
export function builtInGoogleClient(): GoogleClientConfig | null {
  const clientId = constant(() => __GOOGLE_CLIENT_ID__);
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: constant(() => __GOOGLE_CLIENT_SECRET__),
    apiKey: constant(() => __GOOGLE_API_KEY__),
    appId: constant(() => __GOOGLE_PROJECT_NUMBER__),
  };
}

/** The client given by environment (a test run or a build that brings one), if any. */
export function googleClientFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): GoogleClientConfig | null {
  const clientId = env.WORKSPACE_GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: env.WORKSPACE_GOOGLE_CLIENT_SECRET ?? '',
    apiKey: env.WORKSPACE_GOOGLE_API_KEY ?? '',
    appId: env.WORKSPACE_GOOGLE_APP_ID ?? '',
  };
}

/** Which client signs in: the environment's, else the person's own (Settings), else the app's. */
export function chooseGoogleClient(clients: {
  environment: GoogleClientConfig | null;
  own: GoogleClientConfig | null;
  builtIn: GoogleClientConfig | null;
}): { config: GoogleClientConfig; source: GoogleClientSource } | null {
  if (clients.environment) return { config: clients.environment, source: 'environment' };
  if (clients.own) return { config: clients.own, source: 'own' };
  if (clients.builtIn) return { config: clients.builtIn, source: 'built-in' };
  return null;
}
