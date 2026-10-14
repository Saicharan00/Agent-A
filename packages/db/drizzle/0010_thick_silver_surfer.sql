ALTER TABLE `notifications` ADD `bot_id` text REFERENCES bots(id) ON DELETE set null;
