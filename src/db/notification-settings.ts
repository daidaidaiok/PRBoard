import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./index";
import { userInstallations, userNotificationSettings } from "./schema";
import type { NotificationKind } from "./notification-dedup";

export interface NotificationSettings {
  barkUrl: string | null;
  notifyCiGreen: boolean;
  notifyRetryExhausted: boolean;
  notifyPrConflict: boolean;
  notifyDeployFailed: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  barkUrl: null,
  notifyCiGreen: true,
  notifyRetryExhausted: true,
  notifyPrConflict: true,
  notifyDeployFailed: true,
};

/** Rows are lazy — a user who never opened settings reads as all-on/unset. */
export async function getNotificationSettings(userId: number): Promise<NotificationSettings> {
  const [row] = await db
    .select()
    .from(userNotificationSettings)
    .where(eq(userNotificationSettings.userId, userId))
    .limit(1);
  if (!row) return DEFAULT_NOTIFICATION_SETTINGS;
  return {
    barkUrl: row.barkUrl,
    notifyCiGreen: row.notifyCiGreen,
    notifyRetryExhausted: row.notifyRetryExhausted,
    notifyPrConflict: row.notifyPrConflict,
    notifyDeployFailed: row.notifyDeployFailed,
  };
}

export async function upsertNotificationSettings(
  userId: number,
  patch: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  await db
    .insert(userNotificationSettings)
    .values({ userId, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userNotificationSettings.userId,
      set: { ...patch, updatedAt: new Date() },
    });
  return getNotificationSettings(userId);
}

// Exported for tests: the runtime + compile-time (`satisfies` below) guards
// that every NotificationKind has a switch column, so adding a new enum value
// without wiring its setting fails loudly instead of silently notifying.
export const kindSwitchColumn = {
  ci_green: userNotificationSettings.notifyCiGreen,
  ci_retry_exhausted: userNotificationSettings.notifyRetryExhausted,
  pr_conflict: userNotificationSettings.notifyPrConflict,
  deploy_failed: userNotificationSettings.notifyDeployFailed,
} as const satisfies Record<NotificationKind, unknown>;

/**
 * Recipients for one notification kind among the users tied to an
 * installation: must have a Bark URL saved AND that kind's switch on.
 * Empty result = nobody to push to (same silence as the old unset-env path).
 */
export async function listNotifiableUsers(
  installationId: number,
  kind: NotificationKind,
): Promise<Array<{ userId: number; barkUrl: string }>> {
  const rows = await db
    .select({ userId: userInstallations.userId, barkUrl: userNotificationSettings.barkUrl })
    .from(userInstallations)
    .innerJoin(
      userNotificationSettings,
      eq(userNotificationSettings.userId, userInstallations.userId),
    )
    .where(
      and(
        eq(userInstallations.installationId, installationId),
        eq(kindSwitchColumn[kind], true),
        isNotNull(userNotificationSettings.barkUrl),
      ),
    );
  return rows.flatMap((row) =>
    row.barkUrl ? [{ userId: row.userId, barkUrl: row.barkUrl }] : [],
  );
}
