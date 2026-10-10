CREATE TABLE `adjustments` (
	`id` integer PRIMARY KEY NOT NULL,
	`visit_id` integer NOT NULL,
	`claim_line_id` integer,
	`group_code` text NOT NULL,
	`reason_code` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`quantity` integer,
	FOREIGN KEY (`visit_id`) REFERENCES `visits`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claim_line_id`) REFERENCES `claim_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `adjustments_visit_idx` ON `adjustments` (`visit_id`);--> statement-breakpoint
CREATE TABLE `balances` (
	`id` integer PRIMARY KEY NOT NULL,
	`visit_id` integer NOT NULL,
	`status` text NOT NULL,
	`billed_cents` integer NOT NULL,
	`contractual_cents` integer NOT NULL,
	`insurance_paid_cents` integer NOT NULL,
	`patient_responsibility_cents` integer NOT NULL,
	`deductible_cents` integer NOT NULL,
	`coinsurance_cents` integer NOT NULL,
	`copay_cents` integer NOT NULL,
	`other_patient_cents` integer NOT NULL,
	`self_pay_cents` integer NOT NULL,
	`patient_paid_cents` integer DEFAULT 0 NOT NULL,
	`review_reason` text,
	`ai_suggestion` text,
	`paid_on` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`visit_id`) REFERENCES `visits`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balances_visit_unique` ON `balances` (`visit_id`);--> statement-breakpoint
CREATE INDEX `balances_status_idx` ON `balances` (`status`);--> statement-breakpoint
CREATE TABLE `claim_lines` (
	`id` integer PRIMARY KEY NOT NULL,
	`visit_id` integer NOT NULL,
	`line_number` integer NOT NULL,
	`code_qualifier` text NOT NULL,
	`procedure_code` text NOT NULL,
	`modifiers` text NOT NULL,
	`charge_cents` integer NOT NULL,
	`paid_cents` integer NOT NULL,
	`allowed_cents` integer,
	`units` integer,
	`service_date` text,
	`remarks` text NOT NULL,
	FOREIGN KEY (`visit_id`) REFERENCES `visits`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claim_lines_visit_idx` ON `claim_lines` (`visit_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`balance_id` integer,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`balance_id`) REFERENCES `balances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY NOT NULL,
	`balance_id` integer NOT NULL,
	`status` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`sent_on` text,
	`due_date` text,
	`open_count` integer DEFAULT 0 NOT NULL,
	`last_opened_at` text,
	`paypal_invoice_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`balance_id`) REFERENCES `balances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoices_balance_idx` ON `invoices` (`balance_id`);--> statement-breakpoint
CREATE TABLE `patients` (
	`id` integer PRIMARY KEY NOT NULL,
	`practice_id` integer NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`dob` text,
	`email` text,
	`member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`practice_id`) REFERENCES `practices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `patients_name_idx` ON `patients` (`practice_id`,`last_name`,`first_name`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY NOT NULL,
	`balance_id` integer NOT NULL,
	`invoice_id` integer,
	`amount_cents` integer NOT NULL,
	`method` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`posted_on` text NOT NULL,
	`received_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`balance_id`) REFERENCES `balances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_balance_idx` ON `payments` (`balance_id`);--> statement-breakpoint
CREATE TABLE `practices` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address_line1` text NOT NULL,
	`address_line2` text,
	`city` text NOT NULL,
	`state` text NOT NULL,
	`zip` text NOT NULL,
	`phone` text NOT NULL,
	`npi` text,
	`paper_baseline_days` integer,
	`staff_name` text NOT NULL,
	`staff_first_name` text NOT NULL,
	`staff_initials` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `visits` (
	`id` integer PRIMARY KEY NOT NULL,
	`practice_id` integer NOT NULL,
	`patient_id` integer NOT NULL,
	`service_date` text NOT NULL,
	`provider_first_name` text,
	`provider_last_name` text,
	`provider_npi` text,
	`payer_id` text NOT NULL,
	`payer_name` text NOT NULL,
	`payer_short_name` text NOT NULL,
	`payer_kind` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_file` text,
	`claim_id` text NOT NULL,
	`payer_claim_number` text,
	`claim_status_code` text NOT NULL,
	`denied` integer NOT NULL,
	`remarks` text NOT NULL,
	`trace_number` text,
	`payment_date` text,
	`received_date` text,
	`billed_cents` integer NOT NULL,
	`insurance_paid_cents` integer NOT NULL,
	`reported_patient_responsibility_cents` integer NOT NULL,
	`self_pay_rate_applied` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`practice_id`) REFERENCES `practices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`patient_id`) REFERENCES `patients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visits_claim_unique` ON `visits` (`practice_id`,`payer_id`,`claim_id`);