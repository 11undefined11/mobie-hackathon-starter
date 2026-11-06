export function loadConfig(env = process.env) {
  const required = name => {
    const value = env[name]?.trim();
    if (!value || value.includes('YOUR_')) throw new Error(`Set ${name} in .env (see .env.example).`);
    return value;
  };
  const base = new URL(env.MOBIE_API_URL || 'https://api-staging.mobie.at');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || base.hostname.replace(/\.$/, '') === 'api.mobie.at') {
    throw new Error('MOBIE_API_URL must be an HTTPS staging origin, not the production API.');
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const apiKey = required('STARTER_API_KEY');
  if (apiKey.length < 32) throw new Error('STARTER_API_KEY must have at least 32 characters. Generate one with npm run setup.');
  const secret = required('VOICE_INTEGRATION_SECRET');
  if (!/^[\x21-\x7e]{32,}$/.test(secret)) throw new Error('VOICE_INTEGRATION_SECRET must be the organizer-issued team secret (at least 32 printable characters, without spaces).');
  if (env.VOICE_ALLOW_WEB_CALLS && !['true', 'false'].includes(env.VOICE_ALLOW_WEB_CALLS)) throw new Error('VOICE_ALLOW_WEB_CALLS must be true or false.');
  return {
    baseUrl: base.origin, secret, apiKey, mapboxToken: env.MAPBOX_ACCESS_TOKEN?.trim() || '',
    port, host: env.HOST || '127.0.0.1',
    ...(env.VOICE_SESSION_DIRECTORY ? { sessionDirectory: env.VOICE_SESSION_DIRECTORY } : {}),
    ...(env.VOICE_ALLOW_WEB_CALLS ? { allowWebCalls: env.VOICE_ALLOW_WEB_CALLS === 'true' } : {}),
  };
}
