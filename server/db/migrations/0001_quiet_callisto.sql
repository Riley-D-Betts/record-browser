CREATE TABLE `list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_key` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`is_builtin` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_items_list_key_unq` ON `list_items` (`list_key`,`key`);--> statement-breakpoint
CREATE INDEX `list_items_list_idx` ON `list_items` (`list_key`);