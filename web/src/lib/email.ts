/**
 * Transactional email for the hosted deployment.
 *
 * Calls the Resend REST API directly instead of pulling in the SDK: the SDK
 * dragged in svix and uuid, which added three advisories to a dependency the
 * desktop build never executes.
 */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export function defaultFromAddress(): string {
  return process.env.EMAIL_FROM || "ChatMol Lab <noreply@lab.cloudmol.org>";
}

/** Sends one email. Throws when the API key is missing or the API rejects it. */
export async function sendEmail(message: EmailMessage): Promise<{ id?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: message.from || defaultFromAddress(),
      to: [message.to],
      subject: message.subject,
      html: message.html,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Email send failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return (await response.json().catch(() => ({}))) as { id?: string };
}
