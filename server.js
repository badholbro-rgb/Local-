/**
 * Upgrade Her — Telegram Amazon Affiliate Bot
 * Node.js server (hostable on Render)
 *
 * Replicates the N8N workflow:
 *   Telegram Trigger → Extract URL → Parse ASIN → Fetch HTML → Parse Product → Reply
 *
 * ENV VARIABLES (set in Render dashboard):
 *   BOT_TOKEN        — your Telegram bot token
 *   AFFILIATE_TAG    — your Amazon affiliate tag (default: tawhidinsan-20)
 *   PORT             — port number (Render sets this automatically)
 */

const http = require("http");
const https = require("https");

// ─── Config ────────────────────────────────────────────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN     || "YOUR_BOT_TOKEN_HERE";
const AFFILIATE_TAG = process.env.AFFILIATE_TAG || "tawhidinsan-20";
const PORT          = process.env.PORT          || 3000;

// Telegram base URL
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Generic HTTPS GET — returns full body as string */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      (res) => {
        // Follow redirects
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return httpsGet(res.headers.location).then(resolve).catch(reject);
        }
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}

/** POST to Telegram sendMessage */
function sendTelegramMessage(chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Strip HTML tags and decode common entities */
function cleanHtml(text) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// ─── Core Pipeline ─────────────────────────────────────────────────────────

/**
 * Step 1 — Extract & clean Amazon URL + ASIN from raw text
 * Mirrors "Code in JavaScript" node
 */
function extractAmazonUrl(text) {
  if (!text) return { error: "No text provided" };

  const match = text.match(/https?:\/\/\S*amazon\S*/i);
  if (!match) return { error: "No Amazon URL found", text };

  const asinMatch = match[0].match(/\/dp\/([A-Z0-9]{10})/);
  if (!asinMatch) return { error: "ASIN not found", url: match[0] };

  const asin = asinMatch[1];
  return {
    original_url: match[0],
    clean_url: `https://www.amazon.com/dp/${asin}/`,
    asin,
  };
}

/**
 * Step 2 — Parse product details from raw Amazon HTML
 * Mirrors "Filter product details" node
 */
function parseProductHtml(html, asin) {
  const titleMatch = html.match(/id="productTitle"[^>]*>(.*?)<\/span>/s);
  const title = titleMatch ? cleanHtml(titleMatch[1]) : "";

  const features = [];
  const featureRe = /<span class="a-list-item">\s*(.*?)\s*<\/span>/gs;
  let fm;
  while ((fm = featureRe.exec(html)) !== null) {
    const f = cleanHtml(fm[1]);
    if (f.length > 30 && f.length < 500) features.push(f);
  }

  const images = [];
  const imageRe = /"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/g;
  let im;
  while ((im = imageRe.exec(html)) !== null) {
    images.push(im[1]);
    if (images.length >= 2) break;
  }

  return {
    asin,
    title,
    description: features.slice(0, 6).join(" | "),
    image_url_1: images[0] || "",
    image_url_2: images[1] || "",
    raw_features: features,
  };
}

/**
 * Step 3 — Build reply text
 * Mirrors "Send a text message" node template
 */
function buildReplyText(product) {
  return (
    `title: ${product.title}\n\n` +
    `ADIMAGE:${product.image_url_1}\n` +
    `Adimage:${product.image_url_2}\n` +
    `ADLINK: https://amazon.com/dp/${product.asin}/?tag=${AFFILIATE_TAG}\n` +
    `ADZONE: banner\n` +
    `ADWIDTH: 300\n` +
    `ADHEIGHT: 300`
  );
}

/**
 * Full pipeline — runs for every incoming Telegram message
 */
async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text   = message.text;

  // Step 1 — parse URL / ASIN
  const urlData = extractAmazonUrl(text);
  if (urlData.error) {
    await sendTelegramMessage(chatId, `⚠️ ${urlData.error}`);
    return;
  }

  // Step 2 — fetch HTML
  let html;
  try {
    html = await httpsGet(urlData.clean_url);
  } catch (err) {
    await sendTelegramMessage(chatId, `⚠️ Failed to fetch product page: ${err.message}`);
    return;
  }

  // Step 3 — parse product
  const product = parseProductHtml(html, urlData.asin);

  if (!product.title) {
    await sendTelegramMessage(
      chatId,
      "⚠️ Could not extract product details. Amazon may have blocked the request."
    );
    return;
  }

  // Step 4 — send reply
  const reply = buildReplyText(product);
  await sendTelegramMessage(chatId, reply);
}

// ─── Webhook HTTP Server ────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Health check (Render pings this)
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Upgrade Her bot is running ✅");
    return;
  }

  // Telegram webhook endpoint
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        // Process asynchronously so Telegram doesn't retry
        handleUpdate(update).catch((err) =>
          console.error("Pipeline error:", err)
        );
      } catch (err) {
        console.error("Parse error:", err);
        res.writeHead(400);
        res.end("Bad request");
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   Webhook endpoint: POST /webhook`);
});

// ─── Register Webhook with Telegram ────────────────────────────────────────
// Call this once after deploy:
//   curl https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-render-url>/webhook
