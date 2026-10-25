import { eq } from "drizzle-orm";
import { db } from "./index";
import { users } from "./schema";

export async function upsertUser(row: {
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}) {
  const [user] = await db
    .insert(users)
    .values(row)
    .onConflictDoUpdate({
      target: users.githubUserId,
      set: { login: row.login, name: row.name, avatarUrl: row.avatarUrl, lastSeenAt: new Date() },
    })
    .returning();
  return user;
}

export async function getUserByGithubId(githubUserId: number) {
  const [user] = await db.select().from(users).where(eq(users.githubUserId, githubUserId)).limit(1);
  return user ?? null;
}
