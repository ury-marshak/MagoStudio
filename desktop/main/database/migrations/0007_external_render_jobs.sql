CREATE TABLE `external_render_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `provider` text NOT NULL,
  `endpoint` text NOT NULL,
  `kind` text NOT NULL,
  `keychain_account` text NOT NULL,
  `status` text NOT NULL,
  `request_id` text,
  `request_json` text NOT NULL,
  `input_asset_ids` text NOT NULL,
  `output_json` text,
  `error` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `external_render_jobs_status_idx` ON `external_render_jobs` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_render_jobs_provider_request_idx` ON `external_render_jobs` (`provider`, `request_id`);
