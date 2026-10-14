ALTER TABLE `decisions` ADD `number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Number existing decisions in creation order (hand-added backfill).
UPDATE `decisions` SET `number` = (SELECT count(*) FROM `decisions` d2 WHERE d2.`created_at` < `decisions`.`created_at` OR (d2.`created_at` = `decisions`.`created_at` AND d2.`rowid` <= `decisions`.`rowid`));
