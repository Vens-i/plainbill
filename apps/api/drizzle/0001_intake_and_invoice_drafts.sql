CREATE TABLE `intake_batches` (
	`id` integer PRIMARY KEY NOT NULL,
	`practice_id` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`practice_id`) REFERENCES `practices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `intake_files` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`kind` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`reader` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `intake_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `intake_files_batch_idx` ON `intake_files` (`batch_id`);--> statement-breakpoint
CREATE TABLE `intake_items` (
	`id` integer PRIMARY KEY NOT NULL,
	`batch_id` integer NOT NULL,
	`file_id` integer NOT NULL,
	`kind` text NOT NULL,
	`claim` text,
	`extraction` text,
	`resolutions` text NOT NULL,
	`status` text NOT NULL,
	`balance_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `intake_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `intake_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`balance_id`) REFERENCES `balances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `intake_items_batch_idx` ON `intake_items` (`batch_id`);--> statement-breakpoint
CREATE INDEX `intake_items_balance_idx` ON `intake_items` (`balance_id`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `message` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `message_source` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `payment_option` text;