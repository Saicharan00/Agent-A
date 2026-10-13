CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`goal_md` text NOT NULL,
	`constraints_md` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`auto_run` integer DEFAULT false NOT NULL,
	`confirmed_at` text,
	`paused_at` text,
	`max_tasks` integer NOT NULL,
	`max_runs` integer NOT NULL,
	`lead_bot_id` text,
	`thread_id` text,
	`report_run_id` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`lead_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `goal_id` text REFERENCES goals(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `runs_goal_idx` ON `runs` (`goal_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `goal_id` text REFERENCES goals(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `tasks_goal_idx` ON `tasks` (`goal_id`);