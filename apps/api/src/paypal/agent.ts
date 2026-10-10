/**
 * The bill helper's PayPal actions, run through PayPal's Agent Toolkit (@paypal/agent-toolkit).
 *
 * Only two toolkit tools are enabled — create_order and create_subscription — and the model
 * never fills them in: the helper proposes an action, code computes the amounts, the patient
 * confirms on the card, and only then does the server call the toolkit with code-built input.
 * The patient still approves the payment itself in PayPal's window.
 */
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/bedrock';
import type { FakePayPal } from './fake';
import { toPayPalMoney } from './client';

export interface AgentPayPalTools {
  /** Returns the PayPal order id. */
  createOrder(input: { itemName: string; amountCents: number }): Promise<string>;
  /** Returns the PayPal subscription id. */
  createSubscription(planId: string): Promise<string>;
}

export class AgentToolkitError extends Error {
  override name = 'AgentToolkitError';
}

/** The toolkit answers with the PayPal response as a JSON string inside a text block. */
function parseToolResult(result: { content: Array<{ text?: string }> }): { id?: string } {
  let value: unknown = result.content.map((c) => c.text ?? '').join('');
  // Sometimes double-encoded ("\"{...}\""): unwrap until it's an object.
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  if (!value || typeof value !== 'object') {
    throw new AgentToolkitError(`PayPal Agent Toolkit returned: ${String(value).slice(0, 200)}`);
  }
  return value as { id?: string };
}

export class ToolkitAgentTools implements AgentPayPalTools {
  private readonly toolkit: PayPalAgentToolkit;
  private seq = 0;

  constructor(options: { clientId: string; clientSecret: string; env: 'sandbox' | 'live' }) {
    this.toolkit = new PayPalAgentToolkit({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      configuration: {
        actions: { orders: { create: true }, subscriptions: { create: true } },
        context: { sandbox: options.env === 'sandbox' },
      },
    });
  }

  /** The tool names this configuration exposes (create_order, create_subscription). */
  toolNames(): string[] {
    return this.toolkit.getTools().map((t) => t.toolSpec.name);
  }

  private async call(name: string, input: Record<string, unknown>) {
    const result = await this.toolkit.handleToolCall({
      toolUseId: `plainbill-${++this.seq}`,
      name,
      input,
    });
    const parsed = parseToolResult(result);
    if (!parsed.id) {
      throw new AgentToolkitError(`PayPal ${name} did not return an id.`);
    }
    return parsed.id;
  }

  createOrder({ itemName, amountCents }: { itemName: string; amountCents: number }) {
    const value = Number(toPayPalMoney(amountCents).value);
    return this.call('create_order', {
      currencyCode: 'USD',
      items: [{ name: itemName.slice(0, 127), quantity: 1, itemCost: value, itemTotal: value }],
    });
  }

  createSubscription(planId: string) {
    return this.call('create_subscription', { plan_id: planId });
  }
}

/** Test stand-in: the same calls against FakePayPal, recorded. */
export class FakeAgentTools implements AgentPayPalTools {
  readonly calls: Array<{ tool: string; input: unknown }> = [];
  constructor(private readonly paypal: FakePayPal) {}

  async createOrder(input: { itemName: string; amountCents: number }) {
    this.calls.push({ tool: 'create_order', input });
    const order = await this.paypal.createOrder({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'agent',
          custom_id: 'agent',
          description: input.itemName,
          amount: toPayPalMoney(input.amountCents),
        },
      ],
    });
    return order.id;
  }

  async createSubscription(planId: string) {
    this.calls.push({ tool: 'create_subscription', input: { plan_id: planId } });
    const sub = await this.paypal.createSubscription({
      plan_id: planId,
      custom_id: 'agent',
      application_context: {
        brand_name: 'test',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: 'https://example.test',
        cancel_url: 'https://example.test',
      },
    });
    return sub.id;
  }
}
