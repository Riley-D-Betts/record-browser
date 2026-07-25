CREATE TABLE `change_log` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`changed_fields_json` text,
	`user_id` text,
	`batch_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `change_log_entity_idx` ON `change_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `change_log_created_idx` ON `change_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `change_log_batch_idx` ON `change_log` (`batch_id`);--> statement-breakpoint
CREATE TABLE `data_types` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`description` text,
	`is_builtin` integer DEFAULT false NOT NULL,
	`supports_length` integer DEFAULT false NOT NULL,
	`supports_precision` integer DEFAULT false NOT NULL,
	`supports_scale` integer DEFAULT false NOT NULL,
	`supports_options` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_types_key_unq` ON `data_types` (`key`);--> statement-breakpoint
CREATE INDEX `data_types_category_idx` ON `data_types` (`category`);--> statement-breakpoint
CREATE TABLE `field_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`source_field_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_deps_unq` ON `field_dependencies` (`field_id`,`source_field_id`);--> statement-breakpoint
CREATE INDEX `field_deps_field_idx` ON `field_dependencies` (`field_id`);--> statement-breakpoint
CREATE INDEX `field_deps_source_idx` ON `field_dependencies` (`source_field_id`);--> statement-breakpoint
CREATE TABLE `fields` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`api_name` text NOT NULL,
	`label` text NOT NULL,
	`external_id` text,
	`data_type_id` text,
	`type_detail` text,
	`origin` text DEFAULT 'custom' NOT NULL,
	`source_kind` text DEFAULT 'user_entry' NOT NULL,
	`source_expression` text,
	`derivation_language` text,
	`is_externally_populated` integer DEFAULT false NOT NULL,
	`source_notes` text,
	`is_required` integer DEFAULT false NOT NULL,
	`is_unique` integer DEFAULT false NOT NULL,
	`is_primary_key` integer DEFAULT false NOT NULL,
	`is_deprecated` integer DEFAULT false NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`data_type_id`) REFERENCES `data_types`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "fields_derived_shape" CHECK(("fields"."source_kind" = 'derived' AND "fields"."source_expression" IS NOT NULL)
          OR ("fields"."source_kind" <> 'derived' AND "fields"."source_expression" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fields_record_api_name_unq` ON `fields` (`record_id`,`api_name`);--> statement-breakpoint
CREATE INDEX `fields_record_idx` ON `fields` (`record_id`);--> statement-breakpoint
CREATE INDEX `fields_source_kind_idx` ON `fields` (`source_kind`);--> statement-breakpoint
CREATE INDEX `fields_data_type_idx` ON `fields` (`data_type_id`);--> statement-breakpoint
CREATE INDEX `fields_external_idx` ON `fields` (`external_id`);--> statement-breakpoint
CREATE TABLE `modules` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `modules_key_unq` ON `modules` (`key`);--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text,
	`api_name` text NOT NULL,
	`label` text NOT NULL,
	`external_id` text,
	`origin` text DEFAULT 'custom' NOT NULL,
	`description` text,
	`is_deprecated` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_api_name_unq` ON `records` (`api_name`);--> statement-breakpoint
CREATE INDEX `records_module_idx` ON `records` (`module_id`);--> statement-breakpoint
CREATE INDEX `records_external_idx` ON `records` (`external_id`);--> statement-breakpoint
CREATE INDEX `records_origin_idx` ON `records` (`origin`);--> statement-breakpoint
CREATE TABLE `relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_record_id` text NOT NULL,
	`child_record_id` text NOT NULL,
	`via_field_id` text,
	`cardinality` text DEFAULT 'one_to_many' NOT NULL,
	`is_identifying` integer DEFAULT false NOT NULL,
	`on_delete` text DEFAULT 'none' NOT NULL,
	`label` text,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`parent_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`via_field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relationships_unq` ON `relationships` (`parent_record_id`,`child_record_id`,`via_field_id`);--> statement-breakpoint
CREATE INDEX `relationships_parent_idx` ON `relationships` (`parent_record_id`);--> statement-breakpoint
CREATE INDEX `relationships_child_idx` ON `relationships` (`child_record_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unq` ON `users` (`email`);