import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      userId: number;
      githubId: number;
      login: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: number;
    githubId?: number;
    login?: string;
  }
}
