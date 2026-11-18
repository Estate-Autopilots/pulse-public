# Pulse release notes

User-visible changes, fixes, and known issues appear here in newest-first order.

## Unreleased

- Next production release: Willow Lane's agents can read their own install's catalogue, clients and leads, create draft quotes and notify only the salesperson. On their server run `node dist/service-key-admin.js issue <new-secret-file> --scopes catalog.read,clients.read,leads.read,quotes.draft.create,notify.quote_ready --label "Quote agent"`; see [service-key setup and revocation](services/api/SERVICE-KEYS.md). Includes exact phone lookup, a separate failed-auth rate bucket and draft `sourceRef`. In v1, issuing a flagged quote as any leadership-role holder is the approval. Willow Lane's pilot gives the leadership role to their single named approver only.
- Focus home: leadership's Dashboard opens on a calm view of what matters today; Max still shows every panel
- New Pulse mark and a new Pip that floats free, with a lighter top bar and sidebar
- Android shell 1.1.4: GPS site photos use the system rear camera and explicit foreground location prompt; denial keeps the page usable, and existing-photo selection remains available. Hosted acceptance gates each install address; no new native permissions or plugins.

- Added an API/web smoke command and an optional Playwright shell-route suite for QA.
- Known issue: the web application routes are not implemented in this checkout yet; web smoke and end-to-end checks need a running web build.

## v0.3.73

- Updates: a card on Home, an Updates page, and a bell entry and push for each new update
- AI employees: Add member asks if the person is an AI employee; HR and leadership count people and AI apart
- AI co-workers post their progress and results back in the same chat
- Quotations: salespeople open each quote on its own page, and Billing shows its approval badge
- Search offers Billing's sub-pages and finds menu pages by their usual words

## v0.3.72

- WhatsApp names: leadership and HR load names from their own chat exports on the matching screen
- Exports are read on your computer; only names and message counts are sent
- Senders shown as phone numbers are left out, and answers already given never change

## v0.3.71

- Sales home: admins choose per role whether people land on the Dashboard or a simpler sales home
- The sales home shows urgent tasks, today's follow-up calls and your five latest quotations
- Quotations: a second tap can no longer make a duplicate proforma or tax invoice
- Without a phone share sheet, Send downloads the PDF with clear steps and opens WhatsApp only on a tap
- Only Mark sent marks a quotation sent, never sharing or downloading it

## v0.3.70

- Admins can hide screens for each role in Settings → Modules → Screens and menu; hidden screens leave the menu, search and Recents, while Dashboard, Chats, My desk and HR desk always stay
- A private screen where leadership and HR match WhatsApp sender names to colleagues before a chat import
- Quotations print the bank details and the authorised signatory, like invoices

## v0.3.68

- Billing redesign (ERP is now Billing)
- Quote follow-ups
- Workflow builder
- AI co-workers that can post into Chats
- Willow Lane quote drafts and phone lookup
