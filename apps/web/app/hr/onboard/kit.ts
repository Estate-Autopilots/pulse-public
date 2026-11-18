// The rollout kit (PRESENCE-ONBOARD): drafts only. Pulse never sends these; the owner or HR copies and sends them.
// Also written to ~/ea-research/onboard/ by tools/onboard-kit.mjs. Placeholders in <angle brackets> are for HR.

export type KitDoc = { key: string; title: string; audience: string; body: string };

export const ANNOUNCEMENT_EN = `# Check in on Pulse, every working day

Hi everyone,

From **<start date>**, Pulse is where we check in and check out. **Your salary is worked out from it**: days present,
late marks, half-days and leave all come from your Pulse check-ins. Please make it a habit from day one.

**What to do (about 3 minutes, once)**
1. Open Pulse on your phone: <link>. Sign in with your Pulse username and password.
2. Pulse opens "Finish your profile". Add your details, emergency contact, bank account for salary, Aadhaar (masked) and PAN.
3. Install the Pulse app on your phone (Android: <link>). On your laptop, the Pulse app or Chrome extension is optional.
4. Turn on notifications when Pulse asks.

**Every day**
- Arrive → tap **Check in** (top of Pulse, in the phone app, or on your laptop). One tap.
- Going for lunch or a break → **Break**, then **Back**.
- Leaving → **Check out**.
- No signal? Tap anyway. Pulse saves it and syncs when you are back online.

**What is automatic** (only if you agree, in "Office arrival")
- When your phone or laptop reaches the office, Pulse asks **"Check in?"**. HR may let it check you in by itself
  when it is sure (two signals for a few minutes). You always see it in your day and can say "That's not right".
- **Check-out is never automatic.** If you forget, Pulse reminds you, and the missing check-out becomes a correction
  for you to confirm.

**Privacy in 3 lines**
- Pulse checks location or Wi-Fi only at arrival and leaving. No tracking during the day and no location history.
- Your ID numbers are stored masked (last 4 digits) and your documents are encrypted. Only you and HR can see them.
- Every time HR opens your documents it is logged, and you can see that log.

Questions: ask <HR name> (HR) or reply here.

— <name>`;

export const ANNOUNCEMENT_MR = `# Roj Pulse var check-in kara

Namaskar sagalyanna,

**<start date>** pasun Pulse var check-in ani check-out karaycha aahe. **Tumcha pagaar yavarunach thharto**: present
days, late marks, half-days ani leave — sagla Pulse check-in varun yeta. Pahilya divasapasun hi savay laava.

**Ekda karaycha (sumare 3 minute)**
1. Phone var Pulse ugha: <link>. Tumchya Pulse username ani password ne sign in kara.
2. "Finish your profile" ughadel. Tumchi mahiti, emergency contact, pagaarasathi bank account, Aadhaar (masked) ani PAN taaka.
3. Phone var Pulse app install kara (Android: <link>). Laptop var Pulse app kiva Chrome extension optional aahe.
4. Pulse vicharel tevha notifications chalu kara.

**Roj**
- Office la aalyavar → **Check in** daba (Pulse chya varti, phone app madhe kiva laptop var). Ekach tap.
- Jevan kiva break → **Break**, parat aalyavar **Back**.
- Nightana → **Check out**.
- Network nasel tari tap kara. Pulse te save karto ani network aalyavar sync karto.

**Kay automatic aahe** (tumhi "Office arrival" madhe ho mhatlyas)
- Tumcha phone kiva laptop office la pochla ki Pulse vicharto **"Check in?"**. HR ne parvangi dilyas, Pulse la khatri
  asel tevha (don signals kahi minute) to swata check-in karu shakto. He tumhala tumchya divsat disel, ani "That's not
  right" mhanun durust karta yeil.
- **Check-out kadhihi automatic nahi.** Visarlat tar Pulse aathvan karun deto, ani rahilela check-out tumhala confirm
  karaycha correction banto.

**Privacy 3 olit**
- Pulse location kiva Wi-Fi fakt office la yetana ani jatana baghto. Divasbhar tracking nahi, location history nahi.
- Tumche ID numbers masked (shevatche 4 ank) thevle jatat ani documents encrypted astat. Fakt tumhi ani HR baghu shakta.
- HR ne tumche documents ughadle ki tyachi nond hote, ani ti nond tumhi baghu shakta.

Prashna asalyas <HR name> (HR) yanna vichara kiva ithe reply kara.

— <name>`;

export const GUIDE = `# How to check in on Pulse (one page)

**Why it matters:** payroll uses your check-ins. Days present, late marks, half-days and leave come from them.

## 1. Check in when you arrive
Tap **Check in** at the top of Pulse (phone app, phone browser or computer). It turns into a running clock.
*Screenshot: \`header-out-390-light.png\` — the blue "Check in" button beside the bell.*

If Pulse noticed you at the office, it asks **"You're at <office>. Check in?"** — one tap answers it.
*Screenshot: \`header-arrive-390-light.png\`.*

## 2. Breaks
Tap the clock → **Break**. When you are back, tap → **Back**. Break time is not counted as work.
*Screenshot: \`menu/header-in-1440-light.png\`.*

## 3. Check out when you leave
Tap the clock → **Check out**. Done for the day.

## 4. No network?
Tap anyway. Pulse shows "Saved · will sync" and sends it when you are online again (within three hours).

## 5. Something wrong?
My desk → Attendance → **Your day** shows everything, including anything Pulse did by itself.
Tap **That's not right** to ask for a correction. Your manager or HR decides; nothing changes silently.
*Screenshot: \`me-attendance-auto-390-light.png\`.*

## 6. Before payroll
My desk shows **"This is what <month> payroll will use"** with a cut-off date. Fix missing check-outs before it.
*Screenshot: \`me-overview-390-light.png\`.*

Screenshots: \`~/ea-research/onboard/screens/\` (synthetic data).`;

export const CHECKLIST = `# HR checklist: rollout

## Before day 1
- [ ] Confirm the shift times and grace in HR desk → Policies → Working rules.
- [ ] Add the office in Policies → Office presence: location, radius, office Wi-Fi name and access points, office public IP.
- [ ] HR desk → Onboard team → Settings: arrival = **Ask "Check in?"** (recommended to start); reminders **on**, first
      reminder at shift start; payroll cut-off day; profile reminders **on**.
- [ ] Choose which documents to ask for (Aadhaar masked, PAN, cancelled cheque or passbook, others).
- [ ] Check the roster in Onboard team: everyone listed, delivery emails present (invitations need them).
- [ ] Owner approves and sends the announcement (English and Marathi-English drafts in the Rollout kit).

## Day 1
- [ ] Onboard team → select everyone not invited → **Invite** → review → **Send** (only you press Send).
- [ ] Morning: watch "Signed in" and "First check-in" fill up. Nudge people who have not checked in by 11:00.
- [ ] Help anyone stuck: open the person → "Fill in for them" (they can see and change it; it is logged).
- [ ] Afternoon: check the Gaps view: who is missing bank details, Aadhaar or PAN.
- [ ] Evening: look at Attendance for missing check-outs; people get reminded automatically.

## Week 1
- [ ] Daily: Onboard team → "Never checked in" → nudge (one in-app nudge per person per day).
- [ ] Review agents' proposals (from the roster, HR sheets and Drive) and confirm or reject them. IDs are never filled
      in automatically.
- [ ] Check documents: open each (it is logged), mark "Checked" or ask for a new one with a reason.
- [ ] Look at corrections ("That's not right") and decide them promptly.
- [ ] Friday: compare the payroll month on a few My desks with what you expect; tell people about the cut-off date.
- [ ] Decide with the owner whether to switch arrival from "Ask" to "Automatic when sure".`;

export const KIT: KitDoc[] = [
  { key: "announcement-en", title: "Staff announcement (English)", audience: "Everyone · WhatsApp group or email", body: ANNOUNCEMENT_EN },
  { key: "announcement-mr", title: "Staff announcement (Marathi-English)", audience: "Everyone · WhatsApp group", body: ANNOUNCEMENT_MR },
  { key: "guide", title: "How to check in (one page)", audience: "Print or share as an image", body: GUIDE },
  { key: "checklist", title: "HR checklist: day 1 and week 1", audience: "HR", body: CHECKLIST },
];
