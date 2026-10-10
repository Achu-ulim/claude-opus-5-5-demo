// Email delivery, behind one small interface so the provider can change without touching the account code.
//   EMAIL_PROVIDER (a var): 'resend'      Resend's API, with the key in the EMAIL_API_KEY secret
//                           'cloudflare'  Cloudflare Email Service, through a send_email binding named EMAIL
//                           'console'     local dev only: the message is logged instead of sent. Set it in .dev.vars,
//                                         which only wrangler dev reads; never in wrangler.jsonc or the dashboard
//   EMAIL_FROM (a var): the sender, like "Driftbolt <login@driftbolt.online>"
// Unset, no email goes out and logging in on a new device is refused with email_unavailable.
// Addresses and codes are never logged, except the code by 'console'.

// "nightrunner@gmail.com" → "ni•••••@gmail.com": enough for the owner to recognise, not enough for anyone else to use
export function maskEmail(email) {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  return local.slice(0, local.length > 2 ? 2 : 1) + '•••••' + email.slice(at);
}

// whether codes can be delivered
export function mailReady(env) {
  switch (env.EMAIL_PROVIDER) {
    case 'resend': return !!(env.EMAIL_API_KEY && env.EMAIL_FROM);
    case 'cloudflare': return !!(env.EMAIL?.send && env.EMAIL_FROM);
    case 'console': return true;
    default: return false;
  }
}

// msg: { to, subject, text, html }. Never throws: a lost email is retried by the player's Resend.
export async function sendMail(env, msg) {
  if (!mailReady(env)) return;
  try {
    if (env.EMAIL_PROVIDER === 'console') {
      console.log(`[dev mail] to ${maskEmail(msg.to)} | ${msg.subject} | ${msg.text.replace(/\s+/g, ' ')}`);
    } else if (env.EMAIL_PROVIDER === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      });
      if (!res.ok) console.error(`mail: Resend answered ${res.status}`);
    } else {
      const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(env.EMAIL_FROM);
      await env.EMAIL.send({ to: msg.to, from: m ? { name: m[1], email: m[2] } : { email: env.EMAIL_FROM.trim() }, subject: msg.subject, text: msg.text, html: msg.html });
    }
  } catch (e) {
    console.error(`mail: not sent (${e?.name || 'error'})`);
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body) => `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#14151f">
<div style="font-size:22px;font-weight:900;letter-spacing:1px">DRIFT<span style="color:#d9a400">BOLT</span></div>${body}</div>`;

// the 6-digit code for logging in on a new device, or for confirming a new email address
export function codeMail(to, username, code, purpose) {
  const email = purpose === 'email';
  const why = email ? 'confirm this as the new email for your Driftbolt account' : 'log in to Driftbolt on a new device';
  const ignore = email ? 'If you didn\'t ask to change your email, ignore this message.'
    : 'If this wasn\'t you, ignore this message: nobody can log in as you without the code.';
  return {
    to,
    subject: `${code} is your Driftbolt code`,
    text: `Hi ${username}, use ${code} to ${why}. The code works for 10 minutes. ${ignore}`,
    html: page(`<p>Hi <b>${esc(username)}</b>,</p><p>Use this code to ${why}:</p>
<p style="font-size:34px;font-weight:900;letter-spacing:8px;margin:16px 0">${code}</p>
<p style="color:#5b5e73">The code works for 10 minutes. ${esc(ignore)}</p>`),
  };
}

// a receipt once a token purchase is paid: { pack, tokens, amount (₦ text), reference, at (ms) }
export function receiptMail(to, username, r) {
  const date = new Date(r.at).toUTCString().replace(/:\d\d GMT$/, ' UTC');
  const rows = [['Pack', r.pack], ['Tokens', r.tokens.toLocaleString('en-US')], ['Amount', r.amount], ['Reference', r.reference], ['Date', date]];
  return {
    to,
    subject: `Your Driftbolt receipt (${r.reference})`,
    text: `Hi ${username}, thanks for your purchase. ${rows.map(([k, v]) => `${k}: ${v}`).join('. ')}. The tokens are in your Driftbolt wallet.`,
    html: page(`<p>Hi <b>${esc(username)}</b>, thanks for your purchase. The tokens are in your wallet.</p>
<table style="border-collapse:collapse;margin:16px 0">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#5b5e73">${k}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>
<p style="color:#5b5e73">Keep this email: quote the reference if you ever need help with this payment.</p>`),
  };
}

// to the old address once the email has changed
export function changedMail(to, username, masked) {
  const text = `Hi ${username}, the email on your Driftbolt account was changed to ${masked}. If you didn't do this, log in on a device you trust and change it back from Settings.`;
  return { to, subject: 'Your Driftbolt email was changed', text, html: page(`<p>${esc(text)}</p>`) };
}
