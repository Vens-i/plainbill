CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `emails` (
	`id` integer PRIMARY KEY NOT NULL,
	`invoice_id` integer NOT NULL,
	`intended_to` text,
	`delivered_to` text,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`text` text NOT NULL,
	`provider` text NOT NULL,
	`provider_message_id` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `emails_invoice_idx` ON `emails` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `payment_plans` (
	`id` integer PRIMARY KEY NOT NULL,
	`invoice_id` integer NOT NULL,
	`balance_id` integer NOT NULL,
	`months` integer NOT NULL,
	`first_cents` integer NOT NULL,
	`regular_cents` integer NOT NULL,
	`paypal_plan_id` text,
	`paypal_subscription_id` text,
	`status` text NOT NULL,
	`started_on` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`balance_id`) REFERENCES `balances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payment_plans_invoice_idx` ON `payment_plans` (`invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_plans_subscription_unique` ON `payment_plans` (`paypal_subscription_id`);--> statement-breakpoint
CREATE TABLE `paypal_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text NOT NULL,
	`capture_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`captured_at` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `paypal_orders_invoice_idx` ON `paypal_orders` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`resource_id` text,
	`status` text NOT NULL,
	`detail` text,
	`received_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `paypal_invoice_number` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `paypal_status` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `paypal_payer_url` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `sent_via` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `pay_token` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `verify_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `verify_locked_until` text;--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_pay_token_unique` ON `invoices` (`pay_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_paypal_invoice_unique` ON `invoices` (`paypal_invoice_id`);--> statement-breakpoint
ALTER TABLE `payments` ADD `paypal_invoice_txn_id` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `plan_id` integer REFERENCES payment_plans(id);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_external_unique` ON `payments` (`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_invoice_txn_unique` ON `payments` (`paypal_invoice_txn_id`);--> statement-breakpoint
ALTER TABLE `practices` ADD `hours` text;