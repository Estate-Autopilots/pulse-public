// XRAY-LINK (owner, 25 Oct 2026): Learn Pulse: the tutorials and their playlists. One list for the Learn pages, the
// "How do I…" button (pages: where a tutorial is offered) and the video pipeline (tools/tutorials: shots.mjs pictures
// each step and checks that every **Label** is on the screen; learn.py makes the videos and the YouTube kit).
// Words: plain, and **Label** is the exact name of a button, tab or field as Pulse shows it.

export const DONE_KEY = "pulse.learn.done.v1";

/** @type {import("./learn.d.mts").Tutorial[]} */
export const TUTORIALS = [
  {
    id: "tasks-basics", title: "Give and finish tasks", who: "Everyone", minutes: 2, tryHref: "/tasks",
    pages: ["/tasks", "/my-week", "/me/steps"], tags: ["tasks", "to do", "work"],
    summary: "Make a task for yourself or a colleague, see what needs you first, and tick it off when it is done.",
    steps: [
      { text: "Open **Work** in the side rail. **Up next** shows the task to do first, then the one after it.", shot: "01" },
      { text: "Press **New task** and type what needs doing in one line. @name gives it to someone, #project files it, and a day at the end (fri, tomorrow) sets when.", shot: "02" },
      { text: "Press **Create task**. If you named someone, the button says Assign to and their name: it shows in their list and they are told.", shot: "03" },
      { text: "Done? Press the circle beside the task. Tasks waiting on yours move on by themselves.", shot: "04" },
      { text: "Use the tabs **Today**, **This week** and **Blocked** to see the rest, and **Board** or **Calendar** for another view.", shot: "05" },
    ],
  },
  {
    id: "chats-basics", title: "Chat with your team", who: "Everyone", minutes: 2, tryHref: "/chats",
    pages: ["/chats", "/inbox", "/groups", "/communication"], tags: ["chat", "messages", "groups"],
    summary: "Find a chat, send a message, mention someone, turn a message into a task and start a new chat or group.",
    steps: [
      { text: "Open **Chats** in the side rail. **Unread** shows only what you have not read; **Clients** and **Groups** filter the list.", shot: "01" },
      { text: "Pick a chat and type in **Message** at the bottom. Press Enter to send; Shift and Enter make a new line.", shot: "02" },
      { text: "Type **@** to mention someone (they are told), **#** to make a task from the message, **/** for commands.", shot: "03" },
      { text: "To talk to someone new, press **New chat** and choose them, or **New group** to give a group a name, people and a photo.", shot: "04" },
    ],
  },
  {
    id: "close-a-deal", title: "Close a deal: send the client their link", who: "Sales, account managers, founders", minutes: 3, tryHref: "/connections",
    pages: ["/connections", "/clients", "/acquisition"], tags: ["sales", "deal", "client", "onboarding"],
    summary: "The deal is won: make the client's own link to Pulse with the project and what you agreed, and send it to them.",
    steps: [
      { text: "Open **Connections** (search Pulse for it, or find it in your organisation's menu). Scroll to **Invite a client**, below the clients you already work with.", shot: "01" },
      { text: "Type the **Client company** and the **Contact name**. An e-mail or phone is optional.", shot: "02" },
      { text: "Add the **Project** and a **Deal summary**: what you agreed. The client sees the summary when they accept.", shot: "03" },
      { text: "Choose **Their point of contact here**, then press **Make the client link**.", shot: "04" },
      { text: "Send the link: **Copy** it or press **WhatsApp**, or let the client scan the QR code. It works for 30 days; until they accept it waits under **Client requests**, where you can withdraw it.", shot: "05" },
    ],
  },
  {
    id: "invite-a-client", title: "Work with a client inside Pulse", who: "Account managers, client coordinators", minutes: 2, tryHref: "/connections",
    pages: ["/connections", "/clients", "/portal"], tags: ["client", "portal", "invite"],
    summary: "What your client sees when they accept, and how you share a chat and give them tasks once they are in.",
    steps: [
      { text: "Your client opens the link, picks **Just me** (or their company), sets a password and presses **Create my account and accept**. They see only what you share with them.", note: "The client does this on their own phone or computer." },
      { text: "Back in **Connections**, they now show under **Connected organisations**.", shot: "01" },
      { text: "Press **New group with** and their name: a chat you and the client share. Add the people from your team who work with them.", shot: "02" },
      { text: "Press **Give a task to** and their name to ask them for something: photos, a sign-off, a payment. It shows in their tasks and comes back to you for review when they finish.", shot: "03" },
    ],
  },
  {
    id: "make-a-quotation", title: "Make a quotation", who: "Sales, finance, founders", minutes: 3, tryHref: "/erp/new?type=quotation",
    pages: ["/erp", "/quotes"], tags: ["quotation", "quote", "estimate", "billing"],
    summary: "Start a quotation for a client or a project, add what you are selling, and send it for approval or to the client.",
    steps: [
      { text: "Open **Billing** (under Money) and press **New quotation**.", shot: "01" },
      { text: "Under **For whom?**, search the project or client, or leave it empty and choose the client inside the quotation. Press **Start the quotation**.", shot: "02" },
      { text: "The draft opens. Press **Add a line** and type the **Name on the quotation**, **How many** and the **Price before GST**, then **Done**. Lines can also come from your catalogue.", shot: "03" },
      { text: "Press **Choose the client**, check the **Total** (GST is added for you) and press **Approve**: the quotation gets its number, ready to send to the client.", shot: "04" },
    ],
  },
  {
    id: "ai-employees", title: "Work with an AI employee", who: "Founders, managers", minutes: 3, tryHref: "/people",
    pages: ["/people/ai", "/people"], tags: ["AI", "AI employee", "automation"],
    summary: "See your AI employees, decide when they may answer on their own, and approve what they want to send.",
    steps: [
      { text: "Open **Team** and choose **AI** to see your AI employees, each with its role and owner.", shot: "01" },
      { text: "Open one. On **AI**, **Behaviour** says who it listens to (**Leaders only** or **Everyone, clients too**) and whether it answers **On its own**, **Asks first** or **Stays out**.", shot: "02" },
      { text: "**Who approves** is the person who says yes before it sends. **Asked first** lists what it asked and what was decided.", shot: "03" },
      { text: "To add one, press **Add member** on Team and switch on **This is an AI employee**.", shot: "04" },
    ],
  },
  {
    id: "apply-for-leave", title: "Apply for leave", who: "Everyone; HR and pod heads approve", minutes: 2, tryHref: "/me",
    pages: ["/me", "/leave", "/hr"], tags: ["leave", "time off", "HR", "attendance"],
    summary: "Ask for a day off from My desk, see what you have left, and how HR or your pod head approves it.",
    steps: [
      { text: "Open **My desk**. **Time off** shows the leave you have left this year.", shot: "01" },
      { text: "Press **Apply for leave** and choose the kind: **Paid leave**, **Sick leave**, **Personal leave** and so on, with what is free beside each.", shot: "02" },
      { text: "Pick **From** and **To**, and **How much of the day** (a half day works). Weekly offs and holidays are not counted.", shot: "03" },
      { text: "Add a **Reason** for the person approving and press **Send request**. You are told when it is decided.", shot: "04" },
      { text: "HR and pod heads decide it on the **HR desk**, under **Approvals**.", shot: "05" },
    ],
  },
  {
    id: "add-an-expense", title: "Record an expense", who: "Finance, founders", minutes: 2, tryHref: "/finance?tab=entries",
    pages: ["/finance"], tags: ["expense", "finance", "receipt", "GST"],
    summary: "Put an expense, a bill or a payment received into Finance, with its receipt, in under a minute.",
    steps: [
      { text: "Open **Finance** and press **Add entry**.", shot: "01" },
      { text: "Choose what it is: **Expense**, **Bill**, **Payment received**, **Refund** or **Transfer**.", shot: "02" },
      { text: "Type the **Amount** with GST, the **GST in it** (or press 18%), the **Date** and a **Category**.", shot: "03" },
      { text: "Add who it was paid to, the **Client** or **Project** it was for, and a photo of the receipt (**Take photo** or **Choose file**). Then **Save entry**.", shot: "04" },
      { text: "All entries are under **Entries**; the CA checks them month by month.", shot: "05" },
    ],
  },
  {
    id: "telemetry", title: "Find what is slow in Pulse", who: "Admins", minutes: 2, tryHref: "/telemetry",
    pages: ["/telemetry"], tags: ["telemetry", "speed", "errors", "admin"],
    summary: "See which pages, clicks and API calls are slow or failing, for whom, and on which version.",
    steps: [
      { text: "Open **Telemetry** (Settings in the side rail, admins only). **Overview** shows the slowest pages and clicks and the errors.", shot: "01" },
      { text: "Pick the period (**24 hours**, **7 days**, **30 days**) and the platform (**Web**, **Android**, **iPhone**, **Desktop**).", shot: "02" },
      { text: "**Slowest** ranks pages and API routes by their slowest five in a hundred (p95), beside the day before.", shot: "03" },
      { text: "**Errors** lists failed screens and calls; **People & roles** and **Sessions** show who met them.", shot: "04" },
    ],
  },
  {
    id: "product-map", title: "Map an app you are building", who: "Founders, product and engineering", minutes: 2, tryHref: "/product-map",
    pages: ["/product-map", "/story"], tags: ["product map", "screens", "journeys"],
    summary: "Connect an app and Pulse maps its screens, who uses them and the journeys between them.",
    steps: [
      { text: "Open **Product map** (Pulse HQ, Product Story, or search Pulse) and press **Connect an app**.", shot: "01" },
      { text: "Give the app a **Name**, then choose how Pulse reads it: **Read its code**, **Visit it live**, **Read its manifest**, **Real use** or **Push from the build**.", shot: "02" },
      { text: "Fill in the details for that choice and press **Connect and read**. The map of screens, user types and journeys fills in as Pulse reads.", shot: "03" },
    ],
  },
];

/** Playlists: by topic (the hub's default) and by role. `youtube`: the YouTube playlist's title. */
/** @type {import("./learn.d.mts").Playlist[]} */
export const PLAYLISTS = [
  { id: "getting-started", kind: "topic", title: "Getting started", about: "Your first day: tasks and chats.", youtube: "Pulse: Getting started", items: ["tasks-basics", "chats-basics"] },
  { id: "deals", kind: "topic", title: "Deals, quotations and clients", about: "Win the deal, quote it and bring the client in.", youtube: "Pulse for sales & deals", items: ["close-a-deal", "make-a-quotation", "invite-a-client"] },
  { id: "ai", kind: "topic", title: "AI employees", about: "AI team members that ask before they act.", items: ["ai-employees"] },
  { id: "hr", kind: "topic", title: "HR: leave and time", about: "Time off, asked for and approved.", youtube: "Pulse for HR", items: ["apply-for-leave"] },
  { id: "finance", kind: "topic", title: "Finance", about: "Expenses, bills and payments with their receipts.", youtube: "Pulse for finance", items: ["add-an-expense"] },
  { id: "admin", kind: "topic", title: "Telemetry and Product map", about: "For admins and the people building apps.", items: ["telemetry", "product-map"] },
  { id: "role-everyone", kind: "role", title: "For everyone", about: "What every team member uses each day.", items: ["tasks-basics", "chats-basics", "apply-for-leave"] },
  { id: "role-sales", kind: "role", title: "For sales and account managers", about: "From a won deal to a client working with you.", items: ["close-a-deal", "make-a-quotation", "invite-a-client", "chats-basics"] },
  { id: "role-hr", kind: "role", title: "For HR", about: "Leave and the team's day.", items: ["apply-for-leave", "tasks-basics"] },
  { id: "role-finance", kind: "role", title: "For finance", about: "Money in and out, and quotations.", items: ["add-an-expense", "make-a-quotation"] },
  { id: "role-owners", kind: "role", title: "For founders and managers", about: "Run the company: AI employees, speed and your apps.", youtube: "Pulse for managers & owners", items: ["ai-employees", "close-a-deal", "telemetry", "product-map", "tasks-basics"] },
];

export function tutorial(id) {
  return TUTORIALS.find((t) => t.id === id);
}

export function playlistTutorials(id) {
  const p = PLAYLISTS.find((x) => x.id === id);
  return p ? p.items.map(tutorial).filter(Boolean) : [];
}

/** Tutorials offered on a page (its path, without the query): the longest matching page first. */
export function tutorialsFor(pathname) {
  const path = String(pathname || "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const score = (t) => Math.max(-1, ...t.pages.map((p) => (path === p || path.startsWith(p + "/") ? p.length : -1)));
  return TUTORIALS.map((t) => ({ t, s: score(t) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.t);
}

/** A step's words split into plain text and **UI labels**. */
export function stepParts(text) {
  return String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((p) => (p.startsWith("**") && p.endsWith("**") ? { text: p.slice(2, -2), ui: true } : { text: p, ui: false }));
}

/** The done list kept in the browser: only known tutorial ids survive. */
export function parseDone(raw) {
  try {
    const v = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string" && TUTORIALS.some((t) => t.id === x)) : []);
  } catch {
    return new Set();
  }
}
