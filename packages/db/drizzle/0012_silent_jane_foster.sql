ALTER TABLE `mcp_servers` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `domains_json` text DEFAULT '[]' NOT NULL;