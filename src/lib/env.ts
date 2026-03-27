// Called once at startup — throws immediately if any required var is missing.
export function validateEnv() {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (process.env.JWT_SECRET === 'fallback_secret') {
    throw new Error('JWT_SECRET must not be the default fallback in production');
  }
}
