import { describe, expect, it } from 'vitest';
import {
  builtInGoogleClient,
  chooseGoogleClient,
  googleClientFromEnvironment,
} from './google-client';

const client = (clientId: string) => ({ clientId, clientSecret: 's', apiKey: 'k', appId: '1' });

describe('the Google client', () => {
  it("prefers the environment, then the person's own, then the built-in one", () => {
    const environment = client('env');
    const own = client('own');
    const builtIn = client('app');
    expect(chooseGoogleClient({ environment, own, builtIn })).toEqual({
      config: environment,
      source: 'environment',
    });
    expect(chooseGoogleClient({ environment: null, own, builtIn })?.source).toBe('own');
    expect(chooseGoogleClient({ environment: null, own: null, builtIn })).toEqual({
      config: builtIn,
      source: 'built-in',
    });
    expect(chooseGoogleClient({ environment: null, own: null, builtIn: null })).toBeNull();
  });

  it("reads the environment's client, and has no built-in one outside a build", () => {
    expect(googleClientFromEnvironment({})).toBeNull();
    expect(
      googleClientFromEnvironment({
        WORKSPACE_GOOGLE_CLIENT_ID: ' id ',
        WORKSPACE_GOOGLE_API_KEY: 'key',
      }),
    ).toEqual({ clientId: 'id', clientSecret: '', apiKey: 'key', appId: '' });
    expect(builtInGoogleClient()).toBeNull();
  });
});
