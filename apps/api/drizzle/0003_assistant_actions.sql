CREATE TABLE `assistant_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` integer NOT NULL,
	`kind` text NOT NULL,
	`months` integer,
	`amount_cents` integer NOT NULL,
	`remaining_cents` integer NOT NULL,
	`status` text NOT NULL,
	`paypal_order_id` text,
	`paypal_subscription_id` text,
	`created_at` text NOT NULL,
	`confirmed_at` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_actions_invoice_idx` ON `assistant_actions` (`invoice_id`);