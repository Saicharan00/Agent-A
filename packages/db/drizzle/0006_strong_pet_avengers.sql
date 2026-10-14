ALTER TABLE `memories` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Full-text index over memories (F22), kept in sync by triggers. drizzle-kit does not model virtual tables.
CREATE VIRTUAL TABLE `memories_fts` USING fts5(title, content_md, tags, content='memories', content_rowid='rowid', tokenize='porter unicode61');--> statement-breakpoint
INSERT INTO `memories_fts`(rowid, title, content_md, tags) SELECT rowid, title, content_md, tags FROM `memories`;--> statement-breakpoint
CREATE TRIGGER `memories_fts_ai` AFTER INSERT ON `memories` BEGIN
  INSERT INTO `memories_fts`(rowid, title, content_md, tags) VALUES (new.rowid, new.title, new.content_md, new.tags);
END;--> statement-breakpoint
CREATE TRIGGER `memories_fts_ad` AFTER DELETE ON `memories` BEGIN
  INSERT INTO `memories_fts`(`memories_fts`, rowid, title, content_md, tags) VALUES ('delete', old.rowid, old.title, old.content_md, old.tags);
END;--> statement-breakpoint
CREATE TRIGGER `memories_fts_au` AFTER UPDATE ON `memories` BEGIN
  INSERT INTO `memories_fts`(`memories_fts`, rowid, title, content_md, tags) VALUES ('delete', old.rowid, old.title, old.content_md, old.tags);
  INSERT INTO `memories_fts`(rowid, title, content_md, tags) VALUES (new.rowid, new.title, new.content_md, new.tags);
END;
