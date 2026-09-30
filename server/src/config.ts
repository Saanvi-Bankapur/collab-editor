import 'dotenv/config'

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://collab:collab@localhost:5432/collab',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  instanceId: process.env.INSTANCE_ID ?? `server-${process.pid}`,
  compactThreshold: Number(process.env.COMPACT_THRESHOLD ?? 200),
  autoVersionMinutes: Number(process.env.AUTO_VERSION_MINUTES ?? 10),
  /** Public URL of the app, used in notification emails. */
  appUrl: (process.env.APP_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  /** e.g. smtp://user:pass@smtp.example.com:587  (unset = emails are printed to the console) */
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'CoEdit <no-reply@coedit.local>',
  /** AI assist (Claude API). Unset key = AI features are hidden. */
  ...aiConfig(),
  /** Image uploads: set S3_BUCKET (+ AWS credentials) to store in S3, otherwise images go into Postgres. */
  s3Bucket: process.env.S3_BUCKET ?? '',
  s3Region: process.env.S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  s3PublicUrl: (process.env.S3_PUBLIC_URL ?? '').replace(/\/$/, ''),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 5) * 1024 * 1024,
}

if (process.env.NODE_ENV === 'production' && config.jwtSecret === 'dev-secret-change-me') {
  console.error('Refusing to start: set JWT_SECRET to a long random string in production.')
  process.exit(1)
}

/**
 * AI assist provider.
 *  - AI_PROVIDER=openai    -> any OpenAI-compatible Chat Completions API (Groq, Gemini, OpenRouter, Cerebras, ...)
 *  - AI_PROVIDER=anthropic -> Claude Messages API
 * If AI_PROVIDER is not set it is inferred: ANTHROPIC_API_KEY present => anthropic, otherwise openai.
 * The default base URL / model for "openai" are Groq's (free tier): openai/gpt-oss-120b.
 */
function aiConfig() {
  const provider = (process.env.AI_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai')).toLowerCase()
  const anthropic = provider === 'anthropic'
  const key = process.env.AI_API_KEY || (anthropic ? process.env.ANTHROPIC_API_KEY : process.env.GROQ_API_KEY) || ''
  const baseUrl =
    process.env.AI_BASE_URL || (anthropic ? process.env.ANTHROPIC_BASE_URL : '') ||
    (anthropic ? 'https://api.anthropic.com' : 'https://api.groq.com/openai/v1')
  return {
    aiProvider: (anthropic ? 'anthropic' : 'openai') as 'anthropic' | 'openai',
    aiApiKey: key,
    aiBaseUrl: baseUrl.replace(/\/$/, ''),
    aiModel: process.env.AI_MODEL || (anthropic ? 'claude-sonnet-5' : 'openai/gpt-oss-120b'),
    /** Used automatically if AI_MODEL has been retired by the provider (Groq retires models regularly). */
    aiFallbackModel:
      process.env.AI_FALLBACK_MODEL ?? (!anthropic && /groq\.com/.test(baseUrl) ? 'openai/gpt-oss-120b' : ''),
  }
}

export const redisEnabled = !['', 'disabled', 'none', 'off'].includes(config.redisUrl.trim().toLowerCase())
