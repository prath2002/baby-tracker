import "server-only";
import { env, IS_PROD } from "./env";

/** Outbound email/SMS. Message bodies never contain baby health details (spec §31). */
export async function sendEmail(to: string, subject: string, text: string) {
  if (env.EMAIL_PROVIDER === "console") {
    if (IS_PROD) throw new Error("Console email provider is not allowed in production");
    console.info(`[email:console] to=${to} subject="${subject}"\n${text}`);
    devOutbox.push({ to, subject, text, at: new Date().toISOString() });
    return;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
  });
  if (!r.ok) throw new Error(`Email delivery failed (${r.status})`);
}

export async function sendSms(to: string, text: string) {
  switch (env.SMS_PROVIDER) {
    case "console":
      if (IS_PROD) throw new Error("Console SMS provider is not allowed in production");
      console.info(`[sms:console] to=${to} ${text}`);
      devOutbox.push({ to, subject: "SMS", text, at: new Date().toISOString() });
      return;
    case "twilio": {
      const body = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!r.ok) throw new Error(`SMS delivery failed (${r.status})`);
      return;
    }
    default:
      throw new Error("SMS sign-in is not configured. Set SMS_PROVIDER (twilio) or use email.");
  }
}

/** In-memory outbox for development and tests only. */
export const devOutbox: { to: string; subject: string; text: string; at: string }[] = [];
