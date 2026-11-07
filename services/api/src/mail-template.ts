// MAIL-IDENTITY: one e-mail layout for every message Pulse writes, in two looks: Pulse's (platform mail: the Pulse logo
// on top, "Pulse by Vitals Technologies" below) and a company's (its logo, else its name, on top; a quiet "Sent with
// Pulse" below). Built for Gmail on phones and computers: tables and inline styles only (no stylesheet Gmail could drop,
// no web fonts, no background images), one 560px column that shrinks to the screen, 16px text, a 44px-tall button,
// images by Content-ID with their size and alt text set, so nothing jumps or breaks when images are off. Every message
// also has a plain-text part with the same words and links.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InlineImage } from './mail-provider.js';

// Vitals Technologies brand (Brand/04-guide): ink, Pulse red, muted text, page and rule colours.
export const MAIL_COLOURS = { ink: '#0E2A2F', red: '#D63F3A', muted: '#4D6468', page: '#EEF2F1', rule: '#D3DCDB', card: '#FFFFFF' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../data/mail');
const assets = new Map<string, string>();
/** A PNG from services/api/data/mail as base64 (read once). Missing: null, and the e-mail shows the name instead. */
export function mailAsset(file: 'pulse-logo.png' | 'vitals-logo.png'): string | null {
  if (!assets.has(file)) { try { assets.set(file, readFileSync(resolve(dataDir, file)).toString('base64')); } catch { assets.set(file, ''); } }
  return assets.get(file) || null;
}

export type MailLook = { brand: 'pulse' | 'org'; orgName: string | null; orgLogoPng?: string | null; product?: string };
export type RenderedMail = { text: string; html: string; inline: InlineImage[] };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const linkify = (s: string) => esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (u) => `<a href="${u}" style="color:${MAIL_COLOURS.red};text-decoration:underline;word-break:break-all">${u}</a>`);
const P = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;color:${MAIL_COLOURS.ink}`;
const URL_ONLY = /^(?:([^:\n]{2,60}):\s*)?(https?:\/\/\S+)$/;
const CODE = /^(Your [^\n]{0,60}?code) is ([A-Z0-9-]{4,12})$/i;

function button(label: string, url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px"><tr><td bgcolor="${MAIL_COLOURS.red}" style="border-radius:8px">`
    + `<a href="${esc(url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a>`
    + `</td></tr></table><p style="margin:-8px 0 20px;font-family:${FONT};font-size:13px;line-height:20px;color:${MAIL_COLOURS.muted}">Or paste this link into your browser:<br>${linkify(url)}</p>`;
}

function block(par: string) {
  const one = par.trim();
  const code = CODE.exec(one);
  if (code) {
    return `<p style="${P};margin-bottom:8px">${esc(code[1])}:</p>`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="background:${MAIL_COLOURS.page};border:1px solid ${MAIL_COLOURS.rule};border-radius:8px;padding:12px 20px;font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:30px;line-height:36px;letter-spacing:6px;font-weight:700;color:${MAIL_COLOURS.ink}">${esc(code[2])}</td></tr></table>`;
  }
  const link = URL_ONLY.exec(one);
  if (link && !one.includes('\n')) return button(link[1] ? link[1].trim() : 'Open Pulse', link[2]);
  return `<p style="${P}">${linkify(one).replace(/\n/g, '<br>')}</p>`;
}

/** The HTML and plain-text parts of one e-mail, and the images the HTML refers to (cid:). */
export function renderMail(m: { title: string; body: string; signOff?: string | null }, look: MailLook): RenderedMail {
  const product = look.product || 'Pulse';
  const org = (look.orgName ?? '').trim();
  const inline: InlineImage[] = [];
  let header: string;
  if (look.brand === 'org') {
    const logo = look.orgLogoPng && /^[A-Za-z0-9+/=]+$/.test(look.orgLogoPng) ? look.orgLogoPng : null;
    if (logo) inline.push({ cid: 'org-logo', filename: 'logo.png', png: logo });
    header = logo ? `<img src="cid:org-logo" alt="${esc(org || product)}" height="40" style="display:block;height:40px;width:auto;max-width:220px;border:0;outline:none;text-decoration:none">`
      : `<span style="font-family:${FONT};font-size:20px;line-height:28px;font-weight:700;color:${MAIL_COLOURS.ink}">${esc(org || product)}</span>`;
  } else {
    const logo = mailAsset('pulse-logo.png');
    if (logo) inline.push({ cid: 'pulse-logo', filename: 'pulse.png', png: logo });
    header = logo ? `<img src="cid:pulse-logo" alt="${esc(product)}" width="95" height="32" style="display:block;width:95px;height:32px;border:0;outline:none;text-decoration:none">`
      : `<span style="font-family:${FONT};font-size:22px;line-height:28px;font-weight:800;color:${MAIL_COLOURS.ink}">${esc(product)}</span>`;
  }
  const paragraphs = m.body.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const signOff = (m.signOff ?? '').trim();
  const about = look.brand === 'pulse' && org ? `This e-mail is about your account with ${org} on ${product}.` : '';
  let footer: string;
  let footerText: string;
  if (look.brand === 'pulse') {
    const vitals = mailAsset('vitals-logo.png');
    if (vitals) inline.push({ cid: 'vitals-logo', filename: 'vitals.png', png: vitals });
    footer = (vitals ? `<img src="cid:vitals-logo" alt="Vitals Technologies" width="67" height="24" style="display:block;width:67px;height:24px;border:0;margin:0 0 10px">` : '')
      + `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${MAIL_COLOURS.muted}">${about ? esc(about) + '<br>' : ''}${esc(product)} by Vitals Technologies. You got this e-mail because this address was used on ${esc(product)}. Didn’t expect it? You can ignore it safely.</p>`;
    footerText = `${about ? about + '\n' : ''}${product} by Vitals Technologies`;
  } else {
    footer = `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${MAIL_COLOURS.muted}">${esc(org || product)} · Sent with ${esc(product)} by Vitals Technologies</p>`;
    footerText = `${org || product} · Sent with ${product}`;
  }
  const preheader = esc((paragraphs[0] ?? m.title).replace(/\s+/g, ' ').slice(0, 110));
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(m.title)}</title></head>`
    + `<body style="margin:0;padding:0;background:${MAIL_COLOURS.page};-webkit-text-size-adjust:100%">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${MAIL_COLOURS.page}">${preheader}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${MAIL_COLOURS.page}" style="background:${MAIL_COLOURS.page}"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">`
    + `<tr><td style="padding:0 4px 16px">${header}</td></tr>`
    + `<tr><td bgcolor="${MAIL_COLOURS.card}" style="background:${MAIL_COLOURS.card};border:1px solid ${MAIL_COLOURS.rule};border-radius:12px;padding:28px 24px 12px">`
    + `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;color:${MAIL_COLOURS.ink}">${esc(m.title)}</h1>`
    + paragraphs.map(block).join('')
    + (signOff ? `<p style="${P};color:${MAIL_COLOURS.muted}">${esc(signOff)}</p>` : '')
    + `</td></tr><tr><td style="padding:16px 4px 0">${footer}</td></tr></table></td></tr></table></body></html>`;
  const text = [m.body.trim(), signOff, '—', footerText].filter(Boolean).join('\n\n');
  return { text, html, inline };
}
