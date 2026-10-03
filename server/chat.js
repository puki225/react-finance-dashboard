// ─── AI CHAT ASSISTANT ─────────────────────────────────────────────────────
// In-app assistant for the dashboard: answers questions about sales, margin, cash flow,
// procurement and inventory by calling this app's OWN existing API routes as tools - never
// by writing SQL itself and never by touching code. Every read tool below is a thin fetch()
// wrapper around a route index.js already serves (the same one the corresponding page
// calls), so the assistant reuses the exact VAT/refund/FX/Vine/settlement logic those routes
// already get right, instead of re-deriving it.
//
// GUARDRAIL, structural not promptable: this module's tool list is a fixed, hand-written
// allowlist. There is no Bash tool, no file-write tool, no GitHub tool, and no generic
// "run this SQL"/"call this URL" tool - so the assistant cannot touch code or push to a
// repo regardless of what it's asked, because that capability was never wired up, not
// because a prompt tells it not to. The one write capability with real business effect
// (procurement lead time/payment timing) requires a two-step confirm; the "adjust the
// forecasting model" exception is scoped to sales_forecast_config's existing data-level
// stage_override/is_end_of_life fields only - never sales-forecast-service's code.
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');

const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 16000;
const MAX_TOOL_ITERATIONS = 8; // hard stop on the tool-calling loop, so a confused chain of
// calls can't run away and rack up cost - the assistant gets a final turn to answer with
// whatever it has instead of looping forever.
const MAX_TOOL_RESULT_CHARS = 60000; // a handful of these routes can return a LOT of rows
// (product-breakdown across a full catalog, an uncapped date range) - truncate rather than
// hand the model (and the bill) an unbounded payload, with a note telling it to narrow the
// request instead of silently losing data with no explanation.

function createChatRouter({ pool, baseUrl, client: injectedClient }) {
  const router = express.Router();
  const client = injectedClient || new Anthropic();

  // ─── Internal fetch helper - every read tool goes through this ──────────────────────
  async function callInternalApi(path, query = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, v);
    }
    const url = `${baseUrl}${path}${qs.toString() ? '?' + qs.toString() : ''}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `${path} returned ${resp.status}`);
    return data;
  }

  const capResult = (obj) => {
    const text = JSON.stringify(obj);
    if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
    return text.slice(0, MAX_TOOL_RESULT_CHARS)
      + `\n\n[TRUNCATED - result was ${text.length} chars, over the ${MAX_TOOL_RESULT_CHARS} limit. Narrow the date range or add a brand/parent_asin/sku filter and try again rather than assuming the truncated tail.]`;
  };

  // ─── Tool definitions ────────────────────────────────────────────────────────────────
  // Read tools: every one of these is a GET, no side effects, safe to call freely.
  const READ_TOOLS = [
    {
      name: 'get_sales_summary',
      description: "Overall sales summary (gross/net revenue, orders, units) for a date range and channel. Use for \"how did we do\" / top-line questions.",
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
          to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
          channel: { type: 'string', enum: ['all', 'amazon', 'shopify'] },
        },
      },
      run: (input) => callInternalApi('/api/summary', input),
    },
    {
      name: 'get_pnl',
      description: 'Profit & loss broken down by period (day/week/month/quarter/year), with revenue, COGS, fees and margin. Use for margin/profitability trend questions.',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string' }, to: { type: 'string' },
          group: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
          channel: { type: 'string', enum: ['all', 'amazon', 'shopify'] },
          brand: { type: 'string' }, parent_asin: { type: 'string' },
        },
      },
      run: (input) => callInternalApi('/api/pnl', input),
    },
    {
      name: 'get_product_breakdown',
      description: 'Per-product (SKU) sales/margin breakdown for a date range - use for "which product/SKU" questions (best/worst sellers, biggest margin drop, etc). Always pass a brand or parent_asin filter when the user is asking about a specific product rather than the whole catalog.',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string' }, to: { type: 'string' },
          channel: { type: 'string', enum: ['all', 'amazon', 'shopify'] },
          sort: { type: 'string', enum: ['gross_sales', 'net_revenue', 'units_sold', 'total_refunded', 'units_refunded', 'total_discounts', 'gross_profit', 'gross_margin_pct', 'product_contribution'] },
          dir: { type: 'string', enum: ['asc', 'desc'] },
          brand: { type: 'string' }, parent_asin: { type: 'string' },
        },
      },
      run: (input) => callInternalApi('/api/product-breakdown', input),
    },
    {
      name: 'get_pvm_bridge',
      description: 'Price/Volume/Mix bridge decomposing the change in revenue or margin between two date-range scenarios. Use for "why did revenue/margin change" questions. s1 is the base/earlier period, s2 is the comparison period.',
      input_schema: {
        type: 'object',
        properties: {
          s1_from: { type: 'string' }, s1_to: { type: 'string' },
          s2_from: { type: 'string' }, s2_to: { type: 'string' },
          metric: { type: 'string', enum: ['revenue', 'margin'] },
          level: { type: 'string', enum: ['country', 'brand', 'asin'] },
          channel: { type: 'string', enum: ['all', 'amazon', 'shopify'] },
          country: { type: 'string' }, brand: { type: 'string' },
          asin: { type: 'string' }, sku: { type: 'string' },
          exclude_vine: { type: 'boolean' },
        },
        required: ['s1_from', 's1_to', 's2_from', 's2_to'],
      },
      run: (input) => callInternalApi('/api/pvm', input),
    },
    {
      name: 'get_sales_forecast',
      description: 'Sales forecast (per-SKU and totals) alongside recent actuals, including each SKU\'s forecast stage, exclusions and confidence range. Use for "what will we sell" / "is X trending up or down" questions. Each (SKU, country) pair is forecast fully independently - its own stage classification, curve fit, and seasonality, never blended with another country\'s numbers for the same SKU - so a SKU\'s stage/trend can genuinely differ by market. Optionally filter to one brand and/or one country; omit both for the whole catalog, summed across every country. `available_brands`/`available_countries` in the response list every real option (`country` values are shipping-country codes, or \'UNKNOWN\' for a sale whose country wasn\'t captured by the sync - common on this account\'s Amazon side today, not an error).',
      input_schema: {
        type: 'object',
        properties: {
          history_days: { type: 'integer', description: 'How many days of trailing actuals to include, default 60' },
          brand: { type: 'string', description: 'Filter to one brand (exact match) - see available_brands in a prior response, or omit for every brand' },
          country: { type: 'string', description: 'Filter to one country (exact match, e.g. "GB" or "UNKNOWN") - see available_countries in a prior response, or omit to sum across every country' },
        },
      },
      run: (input) => callInternalApi('/api/sales-forecast', input),
    },
    {
      name: 'get_inventory',
      description: 'Current FBA inventory levels per SKU, with sell-through/days-of-supply context. Use for stock-level and reorder-urgency questions.',
      input_schema: { type: 'object', properties: {} },
      run: () => callInternalApi('/api/inventory'),
    },
    {
      name: 'get_shipments',
      description: 'Inbound FBA shipment pipeline: each shipment\'s status (working/shipped/in-transit/delivered/receiving/closed/etc.), destination fulfillment center, confirmed need-by date (often unset - Amazon rarely provides a firm ETA on this API), and per-SKU units shipped vs received. Use for "what stock is on the way" / "when does shipment X land" / reorder-pipeline questions.',
      input_schema: { type: 'object', properties: {} },
      run: () => callInternalApi('/api/shipments'),
    },
    {
      name: 'get_procurement_risk',
      description: 'Per-SKU procurement risk: current sellable stock, units already shipped but not yet received (pending inbound), projected daily sales velocity, days of stock remaining (with and without pending inbound counted), whether the forecasting model has already detected a stock-out dip in the next 90 days, and upcoming recurring Amazon sales events (Black Friday/Cyber Monday, Prime Day, Prime Big Deal Days, Christmas) with days until each starts. Use this BEFORE proposing a procurement change (more or fewer units) - cross-reference days_of_stock against upcoming_events to flag a SKU that won\'t make it to a seasonal spike, or one heavily overstocked heading into a slow month.',
      input_schema: { type: 'object', properties: {} },
      run: () => callInternalApi('/api/procurement-risk'),
    },
    {
      name: 'get_cashflow_projection',
      description: 'Forward cash flow projection: daily inflow (Amazon/Shopify settlements, now driven by the shipment/supply-aware sales forecast), outflow (known outflows, PPC, storage/account fees, procurement - procurement already accounts for real shipments already in transit, not just simulated reorders), resulting balance, and any scheduled procurement orders (`procurement_orders`, each with sku/trigger_date/arrival_date/payment_date/order_qty/amount - order_qty is sized to the sales forecast over the lead time, PLUS 2 extra weeks of safety stock on any order where `includes_safety_stock` is true, meaning stock was already at/below zero when it was triggered - `safety_stock_qty` gives that extra amount; a routine reorder triggered with its buffer still intact gets no padding). PPC and storage/account fees land as lump sums on their real/assumed billing dates, not smeared daily - storage/account fees post with the Amazon settlement itself (`recurring_costs.storage_and_account_fees`, same cadence as `settlement.amazon`); PPC has no real billing-date data available so it assumes a 30-day cycle starting today (`recurring_costs.ppc`) - a stated assumption, not a measured fact. Also returns an estimated credit-line need (`credit.max_utilization`/`max_utilization_date`, plus a per-day `credit_utilization` on each daily row) - how much credit draw would be needed to keep the balance at the configured minimum threshold on days cash alone would fall below it. Use for "will I have enough cash" / "when do I need to reorder X" / "will I need a credit line" questions.',
      input_schema: {
        type: 'object',
        properties: { horizon_days: { type: 'integer', description: 'How many days forward to project, 1-180, default 180' } },
      },
      run: (input) => callInternalApi('/api/cashflow', input),
    },
    {
      name: 'get_procurement_assumptions',
      description: 'Configured procurement lead time and payment timing per product family (parent ASIN or standalone ASIN), plus current combined stock. Use to check what\'s configured before answering a reorder-timing question, or before proposing a change with update_procurement_assumptions.',
      input_schema: { type: 'object', properties: {} },
      run: () => callInternalApi('/api/procurement-assumptions'),
    },
  ];

  // Write tools: each does exactly one narrow thing, through the SAME validated route the
  // manual Settings UI uses (never raw SQL), and is logged to chat_tool_calls.
  const WRITE_TOOLS = [
    {
      name: 'update_procurement_assumptions',
      description: "Set a product family's procurement lead time and/or payment timing (Settings -> Procurement). This changes real projected cash-outflow timing, so it requires confirmation: call this WITHOUT confirmed=true first to show the user what would change, then only call it again WITH confirmed=true after the user has explicitly agreed in this conversation.",
      input_schema: {
        type: 'object',
        properties: {
          parent_asin: { type: 'string', description: 'Parent ASIN, or the standalone ASIN for a product with no parent family' },
          procurement_lead_days: { type: 'integer' },
          payment_days_after_order: { type: 'integer' },
          confirmed: { type: 'boolean', description: 'Must be true to actually apply the change' },
        },
        required: ['parent_asin'],
      },
      is_write: true,
      run: async (input) => {
        if (!input.confirmed) {
          return { status: 'needs_confirmation', message: 'Not applied yet. Summarize this change for the user and re-call with confirmed=true only after they explicitly agree.', proposed: input };
        }
        const resp = await fetch(`${baseUrl}/api/procurement-assumptions/${encodeURIComponent(input.parent_asin)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ procurement_lead_days: input.procurement_lead_days, payment_days_after_order: input.payment_days_after_order }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `update_procurement_assumptions returned ${resp.status}`);
        return { status: 'applied', result: data };
      },
    },
    {
      name: 'update_forecast_config',
      description: "Override a SKU's forecast stage (new/growth/mature/plateau/declining) or mark it end-of-life - a data-level adjustment to the forecasting model's INPUT, not its code (this assistant can never modify sales-forecast-service's code or push anything to a repo). Requires confirmation the same way as update_procurement_assumptions: propose first without confirmed=true, apply only after the user agrees.",
      input_schema: {
        type: 'object',
        properties: {
          sku: { type: 'string' },
          stage_override: { type: 'string', enum: ['new', 'growth', 'mature', 'plateau', 'declining'] },
          is_end_of_life: { type: 'boolean' },
          confirmed: { type: 'boolean' },
        },
        required: ['sku'],
      },
      is_write: true,
      run: async (input) => {
        if (!input.confirmed) {
          return { status: 'needs_confirmation', message: 'Not applied yet. Summarize this change for the user and re-call with confirmed=true only after they explicitly agree.', proposed: input };
        }
        const body = {};
        if (input.stage_override !== undefined) body.stage_override = input.stage_override;
        if (input.is_end_of_life !== undefined) body.is_end_of_life = input.is_end_of_life;
        const resp = await fetch(`${baseUrl}/api/sales-forecast/config/${encodeURIComponent(input.sku)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `update_forecast_config returned ${resp.status}`);
        return { status: 'applied', result: data };
      },
    },
    {
      name: 'remember_fact',
      description: 'Save a short durable fact or preference that should be recalled in every future conversation (e.g. "only ever look at the UK marketplace unless told otherwise"). Low-stakes and reversible - no confirmation needed, but tell the user what you saved.',
      input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
      is_write: true,
      run: async (input) => {
        const result = await pool.query('INSERT INTO chat_memory (fact) VALUES ($1) RETURNING id', [input.fact]);
        return { status: 'saved', id: result.rows[0].id };
      },
    },
  ];

  const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
  const TOOLS_BY_NAME = new Map(ALL_TOOLS.map(t => [t.name, t]));
  const TOOL_DEFS = ALL_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

  const SYSTEM_PROMPT = `You are the finance assistant embedded in this Amazon/Shopify seller's internal dashboard. Answer questions using the tools provided - they call the dashboard's own already-correct endpoints, so trust their numbers over your own arithmetic on raw figures where both are available.

Scope and limits:
- You can read sales, margin (PVM), forecast, inventory, cash flow and procurement data, and propose changes to procurement timing or a SKU's forecast stage/end-of-life flag.
- You have NO ability to modify code, run shell commands, or push anything to GitHub or any other repository - not because you're told not to, but because no such tool exists for you to call. If asked to do this, say so plainly and explain you don't have that capability by design.
- Any write tool that changes procurement timing or forecast config must be proposed first (called without confirmed=true) and only applied (confirmed=true) after the user has explicitly agreed in this conversation - never apply a change the user hasn't actually confirmed, even if it seems obviously correct.
- Prefer calling get_procurement_assumptions or get_sales_forecast to check current state before proposing a change to it.
- Proactively raise procurement risk when it's relevant to what's being discussed (a question about a SKU, inventory, restocking, or an upcoming period), not only when explicitly asked "should I reorder?". Use get_procurement_risk to check days_of_stock (and days_of_stock_with_pending, which counts shipments already in transit) against upcoming_events: if a SKU won't make it to a seasonal event's start_date at its current velocity, or its pending inbound wouldn't cover the demand spike that event typically brings, say so and suggest procuring more, sized to the event's likely scale - the SKU's own forecast_constrained_days_next_90/forecast_first_constrained_date from the same tool tells you whether the forecasting model has already priced in a stock-out. Conversely, flag a SKU sitting on a lot of days of stock heading into a historically slow month (not just "a lot of stock" in isolation - it's only worth mentioning when the stock is high AND there's no seasonal spike coming to work through it) as a candidate to order less next cycle. Keep this to genuinely relevant moments - don't append a procurement aside to every unrelated answer.
- Keep answers concise and concrete - lead with the number/answer, then the "why" if useful. Cite the date ranges and filters you used.
- Refer to products by name, never by SKU code - nobody has those memorized. Every tool that returns per-product data includes a product_name/product_title field; use a short, natural, recognizable form of it (e.g. "the 54mm bottomless portafilter", not the full 150-character Amazon listing title verbatim, and never "P1-16XJ-IUIF"). If two products would be ambiguous under a short name, add just enough of the title to tell them apart. Only mention a SKU or ASIN code at all if the user asks for it directly, or if a product genuinely has no name available in the data.

Formatting - your replies render as Markdown in a chat panel, so use it to make answers scannable rather than one dense paragraph:
- **Bold** the headline number(s) - the answer someone would look for first.
- Use a short bullet list for several related figures, and a Markdown table when comparing more than ~3 items across more than one column (e.g. several SKUs' margin and units).
- Wrap secondary detail worth having but not leading with - a full driver breakdown, caveats, the exact filters used - in a collapsible section: \`<details><summary>Short label</summary>\` ... \`</details>\`. Use this to keep the main answer short, not to hide something the user needs to see immediately.
- Don't over-format a one-line answer - reach for structure only when it actually helps a longer or multi-part answer.

Charts - to illustrate a revenue/sales trend or a margin bridge, emit a fenced code block with the language "chart" containing ONLY a JSON object (no prose inside the block), built from data you already fetched via a tool call - never invent numbers to chart. Two shapes:

Trend (a series over time, e.g. revenue or units by day/week):
\`\`\`chart
{"type":"trend","title":"Net revenue, last 30 days","unit":"currency","currency_symbol":"£","points":[{"label":"2026-08-01","value":1234.56},{"label":"2026-08-02","value":1310.20}]}
\`\`\`

Bridge (a PVM-style breakdown of several named drivers that sum to a total change, e.g. price/volume/mix or a margin-rate bridge):
\`\`\`chart
{"type":"bridge","title":"Margin % bridge: Aug vs PY","unit":"percent","start_label":"Aug 2025","start_value":28.53,"end_label":"Aug 2026","end_value":16.21,"steps":[{"label":"Price","value":-1.31},{"label":"Std COGS","value":0.40}]}
\`\`\`

"unit" is "currency" (pairs with "currency_symbol"), "percent", or "number". Only chart when it genuinely clarifies the point (a real trend or a multi-driver breakdown) - not for a single number, and not more than one chart per answer unless the user is explicitly comparing two things.`;

  // ─── Conversation persistence ───────────────────────────────────────────────────────
  async function loadHistory(conversationId) {
    const result = await pool.query(
      'SELECT role, content FROM chat_messages WHERE conversation_id = $1 ORDER BY id', [conversationId]
    );
    return result.rows.map(r => ({ role: r.role, content: r.content }));
  }
  async function saveMessage(conversationId, role, content) {
    await pool.query(
      'INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3::jsonb)',
      [conversationId, role, JSON.stringify(content)]
    );
    await pool.query('UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
  }
  async function loadMemory() {
    const result = await pool.query('SELECT fact FROM chat_memory ORDER BY id');
    return result.rows.map(r => r.fact);
  }
  async function logToolCall(conversationId, name, input, isWrite, resultSummary) {
    await pool.query(
      'INSERT INTO chat_tool_calls (conversation_id, tool_name, tool_input, is_write, result_summary) VALUES ($1, $2, $3::jsonb, $4, $5)',
      [conversationId, name, JSON.stringify(input), isWrite, resultSummary]
    );
  }

  // ─── POST /api/chat - one conversational turn ───────────────────────────────────────
  router.post('/api/chat', async (req, res) => {
    const { conversation_id, message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    try {
      let conversationId = conversation_id;
      if (!conversationId) {
        const created = await pool.query(
          "INSERT INTO chat_conversations (title) VALUES ($1) RETURNING id",
          [message.slice(0, 80)]
        );
        conversationId = created.rows[0].id;
      }

      const memoryFacts = await loadMemory();
      const system = memoryFacts.length
        ? `${SYSTEM_PROMPT}\n\nRemembered facts from prior conversations:\n${memoryFacts.map(f => `- ${f}`).join('\n')}`
        : SYSTEM_PROMPT;

      const history = await loadHistory(conversationId);
      const messages = [...history, { role: 'user', content: message }];
      await saveMessage(conversationId, 'user', message);

      let iterations = 0;
      let finalText = '';
      while (iterations < MAX_TOOL_ITERATIONS) {
        iterations++;
        const response = await client.messages.create({
          model: MODEL, max_tokens: MAX_TOKENS, system, tools: TOOL_DEFS, messages,
        });

        messages.push({ role: 'assistant', content: response.content });
        await saveMessage(conversationId, 'assistant', response.content);

        if (response.stop_reason !== 'tool_use') {
          finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
          break;
        }

        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const toolResults = [];
        for (const block of toolUseBlocks) {
          const tool = TOOLS_BY_NAME.get(block.name);
          let resultContent, isError = false;
          if (!tool) {
            resultContent = `Unknown tool: ${block.name}`;
            isError = true;
          } else {
            try {
              const result = await tool.run(block.input || {});
              resultContent = capResult(result);
              // Only log an ACTUAL change, not a proposal awaiting confirmation - the audit
              // trail is meant to show what the assistant changed, not every write tool call
              // it made (most of which, by design, apply nothing until the user confirms).
              if (tool.is_write && result && result.status !== 'needs_confirmation') {
                await logToolCall(conversationId, tool.name, block.input, true, resultContent.slice(0, 500));
              }
            } catch (err) {
              resultContent = `Error: ${err.message}`;
              isError = true;
            }
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultContent, ...(isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: toolResults });
        await saveMessage(conversationId, 'user', toolResults);
      }

      if (!finalText && iterations >= MAX_TOOL_ITERATIONS) {
        finalText = "I've made a number of tool calls without reaching a final answer - could you narrow the question (a shorter date range, a specific SKU/brand) and try again?";
      }

      res.json({ conversation_id: conversationId, reply: finalText });
    } catch (err) {
      console.error('[chat]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Conversation list/detail, and durable memory management ───────────────────────
  router.get('/api/chat/conversations', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, title, created_at, updated_at FROM chat_conversations ORDER BY updated_at DESC LIMIT 50'
      );
      res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  router.get('/api/chat/conversations/:id', async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id, 10);
      const messages = await loadHistory(conversationId);
      res.json({ conversation_id: conversationId, messages });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  router.get('/api/chat/memory', async (req, res) => {
    try {
      const result = await pool.query('SELECT id, fact, created_at FROM chat_memory ORDER BY id DESC');
      res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  router.delete('/api/chat/memory/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM chat_memory WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
  });

  return router;
}

module.exports = { createChatRouter };
