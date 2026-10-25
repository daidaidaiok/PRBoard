import NextAuth from "next-auth";
import type { OAuthConfig } from "next-auth/providers";
import { upsertUser, getUserByGithubId } from "@/db/users";

interface GitHubAppProfile {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

/**
 * "Sign in with GitHub App" reuses the standard OAuth authorize/token
 * endpoints, but — unlike a plain OAuth App — the resulting user token's
 * permissions come entirely from what was granted when the App was
 * installed on a repo, not from an OAuth `scope` param. We deliberately
 * omit `scope` here; requesting one would be a no-op at best and confusing
 * at worst.
 */
function GitHubApp(): OAuthConfig<GitHubAppProfile> {
  return {
    id: "github-app",
    name: "GitHub",
    type: "oauth",
    // GitHub implements RFC 9207 and now returns an `iss` param on the
    // callback. next-auth's underlying openid-client validates that param
    // against `issuer` and fails closed if it's missing — even for a plain
    // (non-OIDC) provider like this one. See nextauthjs/next-auth and
    // langfuse/langfuse#13091 for the same failure mode.
    issuer: "https://github.com/login/oauth",
    // A bare string URL makes next-auth assume OIDC defaults and append
    // `scope=openid profile email`, which GitHub's authorize endpoint doesn't
    // use. Override with an empty scope to match the comment above.
    authorization: {
      url: "https://github.com/login/oauth/authorize",
      params: { scope: "" },
    },
    token: "https://github.com/login/oauth/access_token",
    userinfo: "https://api.github.com/user",
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    checks: ["state"],
    profile(profile) {
      return {
        id: String(profile.id),
        name: profile.name ?? profile.login,
        image: profile.avatar_url,
        login: profile.login,
      };
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHubApp()],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ profile }) {
      const p = profile as unknown as GitHubAppProfile | undefined;
      if (!p) return false;
      await upsertUser({ githubUserId: p.id, login: p.login, name: p.name, avatarUrl: p.avatar_url });
      return true;
    },
    async jwt({ token, profile }) {
      if (profile) {
        const p = profile as unknown as GitHubAppProfile;
        token.githubId = p.id;
        token.login = p.login;
        const dbUser = await getUserByGithubId(p.id);
        token.userId = dbUser?.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.githubId = token.githubId as number;
        session.user.login = token.login as string;
        session.user.userId = token.userId as number;
      }
      return session;
    },
  },
});
