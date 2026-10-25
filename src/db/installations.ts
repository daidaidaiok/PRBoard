import { and, eq, inArray } from "drizzle-orm";
import { db } from "./index";
import { installations, installationRepos, userInstallations } from "./schema";

export async function upsertInstallation(row: {
  installationId: number;
  accountGithubId: number;
  accountLogin: string;
  accountType: string;
  suspendedAt: Date | null;
}) {
  await db
    .insert(installations)
    .values(row)
    .onConflictDoUpdate({
      target: installations.installationId,
      set: {
        accountGithubId: row.accountGithubId,
        accountLogin: row.accountLogin,
        accountType: row.accountType,
        suspendedAt: row.suspendedAt,
      },
    });
}

export async function linkInstallationToUser(userId: number, installationId: number) {
  await db.insert(userInstallations).values({ userId, installationId }).onConflictDoNothing();
}

export async function listInstallationsForUser(userId: number) {
  return db
    .select({ installationId: installations.installationId })
    .from(userInstallations)
    .innerJoin(installations, eq(userInstallations.installationId, installations.installationId))
    .where(eq(userInstallations.userId, userId));
}

export async function getInstallation(installationId: number) {
  const rows = await db
    .select({ installationId: installations.installationId, accountGithubId: installations.accountGithubId })
    .from(installations)
    .where(eq(installations.installationId, installationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function countInstallationsForUser(userId: number) {
  return (await listInstallationsForUser(userId)).length;
}

export async function deleteInstallation(installationId: number) {
  await db.delete(installations).where(eq(installations.installationId, installationId));
}

export async function upsertRepos(
  installationId: number,
  repos: Array<{ repoId: number; owner: string; name: string; fullName: string; isPrivate: boolean }>,
) {
  // Repo lists are small at personal scale, so a plain per-row upsert is fine.
  for (const r of repos) {
    await db
      .insert(installationRepos)
      .values({ installationId, ...r })
      .onConflictDoUpdate({
        target: installationRepos.repoId,
        set: { installationId, owner: r.owner, name: r.name, fullName: r.fullName, isPrivate: r.isPrivate },
      });
  }
}

export async function removeReposByRepoId(repoIds: number[]) {
  if (repoIds.length === 0) return;
  await db.delete(installationRepos).where(inArray(installationRepos.repoId, repoIds));
}

export async function removeReposByInstallation(installationId: number) {
  await db.delete(installationRepos).where(eq(installationRepos.installationId, installationId));
}

export async function listWatchedRepos(userId: number) {
  const query = db
    .select({
      installationId: installationRepos.installationId,
      repoId: installationRepos.repoId,
      owner: installationRepos.owner,
      name: installationRepos.name,
      fullName: installationRepos.fullName,
    })
    .from(installationRepos);
  return query
    .innerJoin(userInstallations, eq(userInstallations.installationId, installationRepos.installationId))
    .where(and(eq(installationRepos.watched, true), eq(userInstallations.userId, userId)));
}

export async function getInstallationIdForRepo(fullName: string, userId?: number) {
  const query = db
    .select({ installationId: installationRepos.installationId })
    .from(installationRepos);
  const rows = userId === undefined
    ? await query.where(eq(installationRepos.fullName, fullName)).limit(1)
    : await query
        .innerJoin(userInstallations, eq(userInstallations.installationId, installationRepos.installationId))
        .where(and(eq(installationRepos.fullName, fullName), eq(userInstallations.userId, userId)))
        .limit(1);
  return rows[0]?.installationId ?? null;
}
