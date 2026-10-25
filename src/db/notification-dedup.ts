import { and, eq } from "drizzle-orm";
import { db } from "./index";
import { notificationDedup, notificationKindEnum } from "./schema";

export type NotificationKind = (typeof notificationKindEnum.enumValues)[number];

/**
 * Claims a notification for sending — returns `true` the first time a given
 * (repo, kind, dedupKey) is seen, `false` on every subsequent claim for the
 * same key (a webhook redelivery, or two workflow runs for the same PR both
 * observing the same commit go green). Callers should only push the Bark
 * notification when this returns `true`.
 */
export async function claimNotification(repoFullName: string, kind: NotificationKind, dedupKey: string): Promise<boolean> {
  const [row] = await db
    .insert(notificationDedup)
    .values({ repoFullName, kind, dedupKey })
    .onConflictDoNothing({ target: [notificationDedup.repoFullName, notificationDedup.kind, notificationDedup.dedupKey] })
    .returning({ id: notificationDedup.id });

  return row !== undefined;
}

/**
 * Releases a claim so a future `claimNotification` for the same key notifies
 * again — used for `pr_conflict`, whose "key" (the PR) is long-lived: once a
 * PR becomes mergeable again, the conflict claim is cleared so the *next*
 * time it turns conflicting is a fresh notification instead of a permanent
 * no-op.
 */
export async function clearNotification(repoFullName: string, kind: NotificationKind, dedupKey: string): Promise<void> {
  await db
    .delete(notificationDedup)
    .where(
      and(
        eq(notificationDedup.repoFullName, repoFullName),
        eq(notificationDedup.kind, kind),
        eq(notificationDedup.dedupKey, dedupKey),
      ),
    );
}
