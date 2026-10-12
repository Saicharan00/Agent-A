CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`run_id` text,
	`action` text NOT NULL,
	`details_md` text DEFAULT '' NOT NULL,
	`risk` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_connectors` (
	`bot_id` text NOT NULL,
	`connector_id` text NOT NULL,
	PRIMARY KEY(`bot_id`, `connector_id`),
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bot_thread_sessions` (
	`bot_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`engine` text NOT NULL,
	`engine_session_id` text,
	`last_seen_message_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`bot_id`, `thread_id`),
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`engine` text NOT NULL,
	`model` text,
	`avatar_color` text NOT NULL,
	`avatar_shape` text DEFAULT 'circle' NOT NULL,
	`is_lead` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`container_id` text,
	`novnc_port` integer,
	`mcp_token_hash` text,
	`settings_json` text NOT NULL,
	`sidebar_visible` integer DEFAULT true NOT NULL,
	`notifications` text DEFAULT 'all' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bots_slug_uq` ON `bots` (`slug`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`config_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`context_md` text DEFAULT '' NOT NULL,
	`options_md` text DEFAULT '' NOT NULL,
	`decision_md` text DEFAULT '' NOT NULL,
	`consequences_md` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`task_id` text,
	`thread_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `engine_state` (
	`engine` text PRIMARY KEY NOT NULL,
	`limited_until` text,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guard_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`kind` text DEFAULT 'literal' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`lesson_md` text NOT NULL,
	`why_it_matters_md` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`reviewed_count` integer DEFAULT 0 NOT NULL,
	`next_review_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lessons_next_review_idx` ON `lessons` (`next_review_at`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`bot_id` text,
	`title` text NOT NULL,
	`content_md` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`source_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_scope_bot_idx` ON `memories` (`scope`,`bot_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_bot_id` text,
	`content_md` text NOT NULL,
	`run_id` text,
	`mentions_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_thread_created_idx` ON `messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`link` text,
	`read_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_seq_uq` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`thread_id` text,
	`task_id` text,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`engine` text NOT NULL,
	`prompt` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`duration_ms` integer,
	`error` text,
	`usage_json` text,
	`parent_run_id` text,
	`hop_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_status_created_idx` ON `runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_bot_idx` ON `runs` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_thread_idx` ON `runs` (`thread_id`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`bot_id` text NOT NULL,
	`thread_id` text,
	`cron` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`prompt` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`catch_up` integer DEFAULT false NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `schedules_next_run_idx` ON `schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_events_task_idx` ON `task_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description_md` text DEFAULT '' NOT NULL,
	`acceptance_md` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'p2' NOT NULL,
	`assignee_bot_id` text,
	`created_by` text NOT NULL,
	`parent_task_id` text,
	`origin_thread_id` text,
	`task_thread_id` text,
	`executed_by` text DEFAULT 'agent' NOT NULL,
	`revision_count` integer DEFAULT 0 NOT NULL,
	`result_summary_md` text,
	`artifacts_json` text DEFAULT '[]' NOT NULL,
	`due_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`assignee_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`origin_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assignee_bot_id`);--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE TABLE `thread_members` (
	`thread_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `bot_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_members_bot_idx` ON `thread_members` (`bot_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`explain_mode` integer DEFAULT false NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE INDEX `threads_updated_idx` ON `threads` (`updated_at`);