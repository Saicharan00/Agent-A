CREATE TABLE `bot_mcp_access` (
	`bot_id` text NOT NULL,
	`server_id` text NOT NULL,
	`tool_allowlist_json` text NOT NULL,
	`tool_policies_json` text NOT NULL,
	PRIMARY KEY(`bot_id`, `server_id`),
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args_json` text NOT NULL,
	`cwd` text,
	`url` text,
	`env_refs_json` text NOT NULL,
	`header_refs_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`default_policy` text DEFAULT 'approval' NOT NULL,
	`tool_policies_json` text NOT NULL,
	`tools_cache_json` text,
	`last_check_at` text,
	`last_error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_slug_idx` ON `mcp_servers` (`slug`);