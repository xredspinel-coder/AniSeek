import "dotenv/config";

const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL;

if (!token) {
  throw new Error("BOT_TOKEN is required.");
}

if (!baseUrl) {
  throw new Error("BASE_URL is required.");
}

const webhookUrl = `${baseUrl.replace(/\/+$/, "")}/telegram/webhook`;
const telegramUrl = `https://api.telegram.org/bot${token}/setWebhook`;

const response = await fetch(telegramUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    url: webhookUrl,
    allowed_updates: ["message"]
  })
});

const data = await response.json();

if (!response.ok || !data.ok) {
  throw new Error(`Telegram setWebhook failed: ${JSON.stringify(data)}`);
}

console.log(`Webhook set to ${webhookUrl}`);
