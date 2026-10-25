import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationKind } from "./notification-dedup";

// notification-settings.ts imports ./index (the drizzle client), which throws
// without a live DATABASE_URL — same treatment as check-durations.test.ts.
// The select() mock captures the final `where` expression instead of running
// it, so the recipient-filtering SQL itself can be asserted structurally
// (drizzle renders it to real SQL text via its own PgDialect below).
const { capturedWheres, resolvedRows, selectMock } = vi.hoisted(() => {
  const capturedWheres: unknown[] = [];
  const resolvedRows: Array<{ userId: number; barkUrl: string | null }> = [];
  return {
    capturedWheres,
    resolvedRows,
    selectMock: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: (expr: unknown) => {
            capturedWheres.push(expr);
            return Promise.resolve(resolvedRows);
          },
        }),
      }),
    })),
  };
});

vi.mock("./index", () => ({ db: { select: selectMock } }));

import { kindSwitchColumn, listNotifiableUsers } from "./notification-settings";
import { notificationKindEnum, userInstallations, userNotificationSettings } from "./schema";

const dialect = new PgDialect();

function renderLastWhere() {
  return dialect.sqlToQuery(capturedWheres.at(-1) as Parameters<typeof dialect.sqlToQuery>[0]);
}

describe("kindSwitchColumn", () => {
  it("covers every notification kind (a new enum value without a switch fails here and at compile time)", () => {
    expect(Object.keys(kindSwitchColumn).sort()).toEqual([...notificationKindEnum.enumValues].sort());
  });

  it("maps each kind to its own settings switch column", () => {
    expect(kindSwitchColumn.ci_green).toBe(userNotificationSettings.notifyCiGreen);
    expect(kindSwitchColumn.ci_retry_exhausted).toBe(userNotificationSettings.notifyRetryExhausted);
    expect(kindSwitchColumn.pr_conflict).toBe(userNotificationSettings.notifyPrConflict);
    expect(kindSwitchColumn.deploy_failed).toBe(userNotificationSettings.notifyDeployFailed);
  });
});

describe("listNotifiableUsers", () => {
  beforeEach(() => {
    capturedWheres.length = 0;
    resolvedRows.length = 0;
  });

  it.each([
    ["ci_green", "notify_ci_green"],
    ["ci_retry_exhausted", "notify_retry_exhausted"],
    ["pr_conflict", "notify_pr_conflict"],
    ["deploy_failed", "notify_deploy_failed"],
  ] as const)("gates %s recipients on the installation, the %s switch being on, and a saved bark url", async (kind, columnName) => {
    await listNotifiableUsers(7, kind);

    const { sql, params } = renderLastWhere();
    expect(sql).toContain('"user_installations"."installation_id"');
    expect(params).toEqual([7, true]);
    expect(sql).toContain(`"user_notification_settings"."${columnName}"`);
    expect(sql).toContain('"user_notification_settings"."bark_url" is not null');
  });

  it("returns only rows that actually carry a bark url (a null url is never pushed)", async () => {
    resolvedRows.push(
      { userId: 1, barkUrl: "https://api.day.app/key1" },
      { userId: 2, barkUrl: null },
    );

    const rows = await listNotifiableUsers(7, "deploy_failed");

    expect(rows).toEqual([{ userId: 1, barkUrl: "https://api.day.app/key1" }]);
  });
});
