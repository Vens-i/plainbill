CREATE TABLE `statement_notes` (
	`id` integer PRIMARY KEY NOT NULL,
	`invoice_id` integer NOT NULL,
	`lang` text NOT NULL,
	`notes` text NOT NULL,
	`source` text NOT NULL,
	`fallback` integer DEFAULT false NOT NULL,
	`model` text,
	`balance_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_notes_invoice_lang_unique` ON `statement_notes` (`invoice_id`,`lang`);