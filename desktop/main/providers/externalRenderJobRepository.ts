import { and, eq, inArray } from "drizzle-orm";

import type { DatabaseManager } from "../database/databaseManager";
import { externalRenderJobs } from "../database/schema";

export type ExternalRenderJob = typeof externalRenderJobs.$inferSelect;

const activeRemoteStatuses = ["SUBMITTED", "CANCELLATION_REQUESTED"] as const;

export class ExternalRenderJobRepository {
  constructor(private readonly manager: DatabaseManager) {}

  async beginSubmission(
    input: Pick<
      ExternalRenderJob,
      | "id"
      | "projectId"
      | "provider"
      | "endpoint"
      | "kind"
      | "keychainAccount"
      | "requestJson"
      | "inputAssetIds"
    >
  ): Promise<void> {
    await this.manager
      .get()
      .insert(externalRenderJobs)
      .values({
        ...input,
        status: "SUBMITTING"
      });
  }

  async get(id: string): Promise<ExternalRenderJob | null> {
    const [job] = await this.manager
      .get()
      .select()
      .from(externalRenderJobs)
      .where(eq(externalRenderJobs.id, id));
    return job ?? null;
  }

  listRecoverable(): Promise<ExternalRenderJob[]> {
    return this.manager
      .get()
      .select()
      .from(externalRenderJobs)
      .where(
        inArray(externalRenderJobs.status, [
          ...activeRemoteStatuses,
          "OUTPUT_READY"
        ])
      );
  }

  async markInterruptedSubmissions(): Promise<void> {
    await this.manager
      .get()
      .update(externalRenderJobs)
      .set({
        status: "SUBMISSION_UNKNOWN",
        error: "The app closed before the provider request ID was saved",
        updatedAt: new Date()
      })
      .where(eq(externalRenderJobs.status, "SUBMITTING"));
  }

  async settleSubmission(
    id: string,
    result:
      | { status: "SUBMITTED"; requestId: string }
      | { status: "SUBMISSION_UNKNOWN" | "FAILED"; error: string }
  ): Promise<void> {
    await this.update(id, ["SUBMITTING"], result);
  }

  async markCancellationRequested(id: string): Promise<void> {
    await this.update(id, ["SUBMITTED"], { status: "CANCELLATION_REQUESTED" });
  }

  async settleRemoteJob(
    id: string,
    result:
      | {
          status: "OUTPUT_READY";
          outputJson: NonNullable<ExternalRenderJob["outputJson"]>;
        }
      | { status: "FAILED"; error: string }
      | { status: "CANCELLED" }
  ): Promise<void> {
    await this.update(id, activeRemoteStatuses, result);
  }

  private async update(
    id: string,
    from: readonly ExternalRenderJob["status"][],
    changes: Partial<
      Pick<ExternalRenderJob, "status" | "requestId" | "error" | "outputJson">
    >
  ): Promise<void> {
    await this.manager
      .get()
      .update(externalRenderJobs)
      .set({
        ...changes,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(externalRenderJobs.id, id),
          inArray(externalRenderJobs.status, from)
        )
      );
  }
}
