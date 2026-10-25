import { eq } from "drizzle-orm";
import { db } from "./index";
import { workflowRetryClaims } from "./schema";

export async function claimAutoRetry(params: {
  repoFullName: string;
  workflowRunId: number;
  runAttempt: number;
}): Promise<number | null> {
  const now = new Date();
  const [claim] = await db
    .insert(workflowRetryClaims)
    .values({
      repoFullName: params.repoFullName,
      workflowRunId: String(params.workflowRunId),
      runAttempt: params.runAttempt,
      status: "processing",
      claimedAt: now,
    })
    .onConflictDoUpdate({
      target: [workflowRetryClaims.repoFullName, workflowRetryClaims.workflowRunId, workflowRetryClaims.runAttempt],
      set: { status: "processing", claimedAt: now, completedAt: null, lastError: null },
      setWhere: eq(workflowRetryClaims.status, "failed"),
    })
    .returning({ id: workflowRetryClaims.id });

  return claim?.id ?? null;
}

export async function completeAutoRetryClaim(claimId: number) {
  await db
    .update(workflowRetryClaims)
    .set({ status: "succeeded", completedAt: new Date(), lastError: null })
    .where(eq(workflowRetryClaims.id, claimId));
}

export async function failAutoRetryClaim(claimId: number, error: unknown) {
  await db
    .update(workflowRetryClaims)
    .set({
      status: "failed",
      completedAt: new Date(),
      lastError: error instanceof Error ? error.message : String(error),
    })
    .where(eq(workflowRetryClaims.id, claimId));
}
