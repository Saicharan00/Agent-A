CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`outcome` text NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`reason` text,
	`run_id` text,
	`thread_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `schedule_runs_schedule_idx` ON `schedule_runs` (`schedule_id`,`created_at`);