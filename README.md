# cf-email-router

Cloudflare **Email Worker** that parses inbound mail, posts it to [Discord incoming webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks), and optionally forwards a copy per route.

Routing is defined only via the **`EMAIL_ROUTES`** secret (JSON array; **first match wins**). Embed limits, trimmed description, optional full-body attachment, and file-size cap follow the same ideas as [Tyler-OBrien/cloudflare-worker-emails-to-discord](https://github.com/Tyler-OBrien/cloudflare-worker-emails-to-discord).

## Setup

1. For routes that post to Discord, create webhooks in the target channels (not every route needs one).
2. **Deploy the worker**

   If this repo is **connected to Workers** (Git integration / Workers Builds), pushing to the linked branch is enough: Cloudflare runs `npm install` and deploys using `wrangler.toml`. You do not need local `wrangler login` for that path.

   For a **manual** deploy from your machine:

   ```bash
   npm install
   npx wrangler deploy
   ```

3. Set the **`EMAIL_ROUTES`** secret to a JSON array (dashboard: Worker → Settings → Variables and secrets, or `npx wrangler secret put EMAIL_ROUTES`). Put a catch-all route last using `"to": "*"`.

   ```json
   [
     {
       "to": ["support@yourdomain.com", "help@yourdomain.com"],
       "from": "alerts@partner.com",
       "discordWebhookUrl": ["https://discord.com/api/webhooks/111/aaa"],
       "forwardTo": ["team-inbox@yourdomain.com"]
     },
     {
       "to": "orders@yourdomain.com",
       "discordWebhookUrl": ["https://discord.com/api/webhooks/222/bbb"],
       "forwardTo": ["orders-archive@yourdomain.com"]
     },
     {
       "to": "legal@yourdomain.com",
       "forwardTo": ["counsel@yourdomain.com"]
     },
     {
       "to": "*",
       "discordWebhookUrl": ["https://discord.com/api/webhooks/333/ccc"]
     }
   ]
   ```

   - **`to`**: envelope recipient (`message.to`). After normalizing to a plain `local@domain` string (case-insensitive), each entry must **match exactly** — this is **not** a regular expression. Patterns like `*@yourdomain.com` are **not** supported. The only wildcard is the literal string **`"*"`**, which matches any recipient. Use a string or an array of strings.
   - **`from`** (optional): omit this key to allow **any** sender for that `to`. If present, each value is a **sender email** matched by **exact address** (after the same normalization as `to`), **not** regex. A message matches if **either** the SMTP envelope sender or the parsed `From:` header address equals one of the listed addresses. String or array of strings.
   - **`discordWebhookUrl`** (optional): JSON **array** of webhook URL strings — use `["https://..."]` even for a single webhook. Multiple entries each get the same Discord payload. Aliases: `webhook`, `webhookUrl`, `discord_webhook_url`. Only the **first** of these keys present on the route is used.
   - **`forwardTo`** (optional): JSON **array** of verified addresses — use `["a@b.com"]` even for one recipient. `forward_to` is an alias. Omit the key entirely if you do not forward on that route.
   - Each route must include **at least one** webhook URL or **at least one** forward address (after trimming empty strings). You can combine both on the same route.

4. In the Cloudflare dashboard, configure **Email Routing** so mail reaches this worker.

   A practical pattern is a **catch-all** (or “send to Worker”) rule for your domain so **every** `local-part@yourdomain` is handled by the worker **without** adding each address—or each possible **From**—in Email Routing. You still decide what happens in **`EMAIL_ROUTES`**: match on envelope **`to`** (exact addresses or `"*"` last), and optionally **`from`** when you need sender-specific rules.

### Local reference copy

Cloudflare does not show secret values after you save them. Keep a **private** copy on disk:

- Edit **`email-routes.local.json`** (gitignored) with your real webhooks and forwards, then paste **minified** JSON into the `EMAIL_ROUTES` secret when you deploy or rotate webhooks.
- **`email-routes.example.json`** is a tracked template you can copy from for new setups (`cp email-routes.example.json email-routes.local.json`).

## Optional configuration

- **`DISCORD_FILE_LIMIT_BYTES`** — Add under `[vars]` in `wrangler.toml` if you want. Default is `8000000` (8MB). Raise on boosted Discord servers if needed.

## Limits and reliability

- Discord embed description is capped at 4096 characters; longer bodies are truncated in the embed and the full text is attached when possible.
- If the webhook request fails, the error is logged; the worker does not retry. Per-route `forwardTo` runs before posting to Discord so you still get a mailbox copy when Discord is down.
- Missing/invalid `EMAIL_ROUTES`, or no matching route, rejects the message with an SMTP error so misconfiguration is visible.

## Local development

`wrangler dev` does not fully simulate Email Workers; use dashboard routing and test sends for end-to-end checks.
