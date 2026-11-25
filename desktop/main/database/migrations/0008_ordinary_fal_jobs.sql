CREATE TABLE "ordinary_fal_jobs" (
  "job_id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "shot_id" text NOT NULL,
  "model" text NOT NULL,
  "kind" text NOT NULL,
  "keychain_account" text NOT NULL,
  "input_digest" text NOT NULL,
  "destination" text NOT NULL,
  "effective_settings" text NOT NULL,
  "placement" text DEFAULT 'PENDING' NOT NULL,
  "clip_id" text,
  "created_at" integer DEFAULT (unixepoch() * 1000) NOT NULL,
  "updated_at" integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ordinary_fal_jobs_project_idx" ON "ordinary_fal_jobs" ("project_id");
