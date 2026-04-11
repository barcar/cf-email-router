import PostalMime from "postal-mime";
import { convert } from "html-to-text";

const DISCORD_EMBED_LIMIT = 4096;

function trimToLimit(input, limit) {
  if (input == null) return "";
  const s = String(input);
  return s.length > limit ? `${s.substring(0, limit - 12)}...(TRIMMED)` : s;
}

function discordFileLimitBytes(env) {
  const raw = env.DISCORD_FILE_LIMIT_BYTES;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 8_000_000;
}

/** Extract a@b.c from "Name <a@b.c>" or return trimmed lowercased local part+domain. */
function normalizeEmailAddress(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  const angle = s.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : s).trim().toLowerCase();
  return addr;
}

function asList(value) {
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * @param {object} route
 * @param {string} messageTo
 * @param {string} messageFrom - envelope from
 * @param {string} headerFrom - parsed From address (may differ from envelope)
 */
function routeMatches(route, messageTo, messageFrom, headerFrom) {
  const toPatterns = asList(route.to);
  if (toPatterns.length === 0) return false;

  const normTo = normalizeEmailAddress(messageTo);
  let toOk = false;
  for (const p of toPatterns) {
    const pat = String(p).trim().toLowerCase();
    if (pat === "*" || pat === normTo) {
      toOk = true;
      break;
    }
  }
  if (!toOk) return false;

  const fromPatterns = asList(route.from);
  if (fromPatterns.length === 0) return true;

  const normEnvFrom = normalizeEmailAddress(messageFrom);
  const normHdrFrom = normalizeEmailAddress(headerFrom);
  for (const p of fromPatterns) {
    const pat = String(p).trim().toLowerCase();
    if (pat === normEnvFrom || pat === normHdrFrom) return true;
  }
  return false;
}

const WEBHOOK_ROUTE_KEYS = [
  "discordWebhookUrl",
  "discord_webhook_url",
  "webhook",
  "webhookUrl",
];

/**
 * Webhook URLs: omit all alias keys for none, or set exactly one alias to a JSON array
 * (even for a single URL). Returns null if a key is set but the value is not an array.
 */
function webhooksFromRoute(route) {
  let raw;
  for (const key of WEBHOOK_ROUTE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(route, key)) {
      raw = route[key];
      break;
    }
  }
  if (raw === undefined) return [];
  if (raw === null || raw === "") return [];
  if (!Array.isArray(raw)) {
    console.error(
      "discordWebhookUrl (or webhook alias) must be a JSON array of URL strings, even for one webhook"
    );
    return null;
  }
  return raw.map((u) => String(u).trim()).filter(Boolean);
}

/**
 * Forward destinations: omit forwardTo / forward_to for none, or set to a JSON array
 * (even for one address). Returns null if set but not an array.
 */
function forwardTosFromRoute(route) {
  const hasForward =
    Object.prototype.hasOwnProperty.call(route, "forwardTo") ||
    Object.prototype.hasOwnProperty.call(route, "forward_to");
  if (!hasForward) return [];
  const raw = Object.prototype.hasOwnProperty.call(route, "forwardTo")
    ? route.forwardTo
    : route.forward_to;
  if (raw === null || raw === "") return [];
  if (!Array.isArray(raw)) {
    console.error(
      "forwardTo must be a JSON array of addresses, even for a single destination"
    );
    return null;
  }
  return raw.map((a) => String(a).trim()).filter(Boolean);
}

/**
 * @returns {{ ok: true, webhookUrls: string[], forwardTos: string[] } | { ok: false, reason: string }}
 */
function resolveDestination(message, parsedFromAddress, env) {
  const rawRoutes = env.EMAIL_ROUTES?.trim();
  if (!rawRoutes) {
    return { ok: false, reason: "EMAIL_ROUTES is not set" };
  }

  let routes;
  try {
    routes = JSON.parse(rawRoutes);
  } catch (e) {
    console.error("EMAIL_ROUTES is not valid JSON:", e);
    return { ok: false, reason: "EMAIL_ROUTES is not valid JSON" };
  }
  if (!Array.isArray(routes)) {
    console.error("EMAIL_ROUTES must be a JSON array of route objects");
    return { ok: false, reason: "EMAIL_ROUTES must be a JSON array" };
  }

  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    if (!routeMatches(route, message.to, message.from, parsedFromAddress)) {
      continue;
    }
    const webhookUrls = webhooksFromRoute(route);
    const forwardTos = forwardTosFromRoute(route);
    if (webhookUrls === null || forwardTos === null) {
      continue;
    }

    if (webhookUrls.length === 0 && forwardTos.length === 0) {
      console.error(
        "Matched route has no discordWebhookUrl (or webhook) and no forwardTo"
      );
      continue;
    }

    return {
      ok: true,
      webhookUrls,
      forwardTos,
    };
  }

  return { ok: false, reason: "No matching route for this message" };
}

async function postToDiscord(webhookUrl, message, email, emailText, fileLimit) {
  const fromName = email.from?.name ?? "";
  const fromAddress = email.from?.address ?? "";
  const authorLine = `${trimToLimit(fromName, 100)}${
    fromName.length > 64 ? "\n" : " "
  }<${trimToLimit(fromAddress, 100)}>`;

  const embedBody = JSON.stringify({
    embeds: [
      {
        title: trimToLimit(email.subject ?? "(no subject)", 256),
        description:
          emailText.length > DISCORD_EMBED_LIMIT
            ? `${emailText.substring(0, DISCORD_EMBED_LIMIT - 12)}...(TRIMMED)`
            : emailText,
        author: {
          name: trimToLimit(authorLine, 256),
        },
        footer: {
          text: trimToLimit(
            `This email was sent to ${trimToLimit(message.to, 100)}\nEnvelope From: ${trimToLimit(message.from, 100)}`,
            2048
          ),
        },
      },
    ],
  });

  const formData = new FormData();
  formData.append("payload_json", embedBody);

  if (emailText.length > DISCORD_EMBED_LIMIT) {
    const newTextBlob = new Blob([emailText], { type: "text/plain" });
    if (newTextBlob.size < fileLimit) {
      formData.append("files[0]", newTextBlob, "email.txt");
    } else {
      formData.append(
        "files[0]",
        newTextBlob.slice(0, fileLimit, "text/plain"),
        "email-trimmed.txt"
      );
    }
  }

  const discordResponse = await fetch(webhookUrl, {
    method: "POST",
    body: formData,
  });

  if (!discordResponse.ok) {
    let detail = "";
    try {
      detail = await discordResponse.text();
    } catch {
      /* ignore */
    }
    console.error(
      "Discord webhook failed:",
      discordResponse.status,
      discordResponse.statusText,
      detail
    );
  }
}

export default {
  async email(message, env) {
    const rawEmail = new Response(message.raw);
    const arrayBuffer = await rawEmail.arrayBuffer();
    const parser = new PostalMime();
    const email = await parser.parse(arrayBuffer);

    const parsedFromAddress = email.from?.address ?? "";

    const dest = resolveDestination(message, parsedFromAddress, env);
    if (!dest.ok) {
      message.setReject(dest.reason);
      return;
    }

    for (const addr of dest.forwardTos) {
      await message.forward(addr);
    }

    if (dest.webhookUrls.length === 0) {
      return;
    }

    let emailText = email.text;
    if (!emailText && email.html) {
      emailText = convert(email.html);
    }
    if (!emailText) {
      emailText = "(no text body)";
    }

    const fileLimit = discordFileLimitBytes(env);
    for (const webhookUrl of dest.webhookUrls) {
      await postToDiscord(webhookUrl, message, email, emailText, fileLimit);
    }
  },
};
