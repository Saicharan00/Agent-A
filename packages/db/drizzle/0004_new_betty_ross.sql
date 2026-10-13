ALTER TABLE `threads` ADD `paused_at` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `notifications` text DEFAULT 'all' NOT NULL;