import { db } from "./index";
import { auditLog, type auditActionEnum, type auditResultEnum } from "./schema";

type AuditAction = (typeof auditActionEnum.enumValues)[number];
type AuditResult = (typeof auditResultEnum.enumValues)[number];

export async function logAudit(entry: {
  userId: number | null;
  action: AuditAction;
  result: AuditResult;
  repoFullName: string;
  prNumber?: number;
  targetId?: string;
  detail?: unknown;
}) {
  await db.insert(auditLog).values({
    userId: entry.userId,
    action: entry.action,
    result: entry.result,
    repoFullName: entry.repoFullName,
    prNumber: entry.prNumber ?? null,
    targetId: entry.targetId ?? null,
    detail: entry.detail ?? null,
  });
}
