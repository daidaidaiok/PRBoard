import { auth } from "@/auth";
import { getUserByGithubId } from "@/db/users";

/**
 * Every API route that touches GitHub data or triggers an action calls this
 * first. Routes re-check here rather than trusting that a session implies
 * authorization forever, and backfill the database user id for old JWTs.
 */
export async function requireSession() {
  const session = await auth();
  if (!session?.user) return null;
  if (session.user.userId) return session;
  const user = await getUserByGithubId(session.user.githubId);
  if (!user) return null;
  return { ...session, user: { ...session.user, userId: user.id } };
}
