import { z } from "zod";

const envSchema = z.object({
  GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required"),
  GITHUB_APP_SLUG: z.string().min(1, "GITHUB_APP_SLUG is required"),
  GITHUB_APP_CLIENT_ID: z.string().min(1, "GITHUB_APP_CLIENT_ID is required"),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1, "GITHUB_APP_CLIENT_SECRET is required"),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1, "GITHUB_APP_PRIVATE_KEY is required"),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1, "GITHUB_APP_WEBHOOK_SECRET is required"),
});

/**
 * PEM private keys are often stored in env vars with literal "\n" sequences
 * instead of real newlines (Vercel dashboard, .env files). Normalize both forms.
 */
function normalizePrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

let cached: z.infer<typeof envSchema> | null = null;

export function getGitHubAppEnv() {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Missing/invalid GitHub App environment variables: ${parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}. See docs/SETUP.md.`,
    );
  }
  cached = { ...parsed.data, GITHUB_APP_PRIVATE_KEY: normalizePrivateKey(parsed.data.GITHUB_APP_PRIVATE_KEY) };
  return cached;
}
