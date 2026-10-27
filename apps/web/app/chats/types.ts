export type Member = { id: string; name: string; username: string | null; pod?: string | null; team?: string | null; role?: 'member' | 'admin'; photoAt?: string | null; company?: string | null;
  /** EST-1035: an AI co-worker (leaders see them; it answers in seconds and real work becomes a task). */
  agent?: boolean; employeeId?: string | null };
export type ChannelKind = 'pod' | 'team' | 'group' | 'direct' | 'custom';
/** CHAT-VOICE: `voice` marks a file as a voice note: its length in seconds and its waveform (bars 4–100). */
export type Attachment = { id?: string; name: string; url?: string; mime?: string; task?: string; voice?: { seconds: number; peaks: number[] };
  /** CHAT-V3: a new version of an earlier picture or file (revision rounds): its number and the message it replaces. */
  version?: number; prev?: string;
  /** CHAT-V3: an event line's link to the message it is about (pinned, an approval asked or answered; CHAT-V5: a poll closed). */
  pinned?: string; approval?: string; poll?: string;
  /** CHAT-VOICE: a call's line in the conversation (kind 'event'). */
  call?: string; video?: boolean; state?: string; seconds?: number | null;
  /** WA-NATIVE: a file of history imported from WhatsApp (id "wa-<sha256>"): the original's SHA-256, its kind and size,
   *  a picture's size, a video's still and browser copy; or a file the export left out (`omitted`: its kind). */
  wa?: string; kind?: string; size?: number; w?: number; h?: number; poster?: string; playable?: string; omitted?: string;
  /** CALLS-V2: a call's recording (kind 'event'): its state and those of its transcript and notes. */
  recording?: string; recordingState?: string; transcript?: string; summary?: string };
export type Channel = { id: string; moderationOnly?:boolean;
  /** GROUP-ACCESS: a client group read through the organisation's setting, not as a member (read-only; Join to post). */
  browsing?: boolean; name: string; kind: ChannelKind; description: string; address: string | null; unread: number; mentions?:number; members: number; lastAt: string | null;
  preview?: string | null; previewAuthor?: string | null; previewAuthorId?: string | null; previewKind?: string | null; previewRemoved?: boolean | null; previewImported?: boolean | null; previewAttachment?: Attachment | null; duplicateOf?: string | null;
  photoAt?: string | null; peerId?: string | null; peerFormer?: boolean; peerAgent?: boolean; peerPhotoAt?: string | null; peerUsername?: string | null; peerDepartment?: string | null; pinnedAt?: string | null; myRole?: 'member' | 'admin' | null;
  /** R47: imported WhatsApp history this member can read (groups people made and direct chats only). */
  imported?: number;
  /** WA-IMPORT: the WhatsApp group this chat was made from (its members and admins see it). */
  whatsapp?: { chatId: string; messages: number; firstAt: string | null; lastAt: string | null;
    /** WA-NATIVE: the history is this chat's own messages now (how many), and the senders who are guests here. */
    native?: boolean; nativeMessages?: number | null; guests?: number } | null;
  /** CONNECT: shared with another organisation through a connection: its name ("with <organisation>"). */
  withOrg?: string | null;
  /** CHAT-V3: my own settings for this chat (muted until, archived), and whether people outside the company are in it. */
  mutedUntil?: string | null; archivedAt?: string | null; clientFacing?: boolean;
  /** VISIBLE: a client's group (the groups hub says client, or the WhatsApp import linked it to a client record). */ clientGroup?: boolean;
  /** CHAT-V4: marked unread by me (until I open it). */
  markedUnread?: string | null;
  /** CHAT-V5: my reminders that rang here and are not seen yet; my messages waiting to be sent here. */
  reminders?: number; scheduled?: number };
export type Quote = { id: string; authorId: string; name: string; body: string; removed: boolean; attachments: number };
export type ChatMessage = { id: string; channelId: string; authorId: string; name: string; username: string | null; photoAt?: string | null; body: string; parentId: string | null; quoteId?: string | null; quote?: Quote | null; kind?: 'text' | 'event';
  /** LIFECYCLE: the author is no longer in this conversation (left the company, or the pod or team). */
  former?: boolean;
  /** WA-NATIVE: moved here from the WhatsApp group (the chat carries one marker); written by a WhatsApp guest (no
   *  account: `name` reads "name (WhatsApp)"); the people its mentions name (a client contact has no username). */
  imported?: boolean; guest?: boolean; mentioned?: { id: string; name: string; username: string | null }[] | null;
  /** EST-1035: written by an AI co-worker; its run as the model reported it (tokens null: not reported, shown as unknown). */
  byAgent?: boolean; employeeId?: string | null;
  agentRun?: { lane: string; model: string; tokens: number | null; seconds: number | string | null; state: 'dispatching' | 'done' | 'error' | 'uncertain' } | null;
  /** EST-1035: a leader's question to a co-worker, and where its answer stands. */
  /** AI-EMPLOYEES v2: an AI employee's proposal: on the direct message asking its approver ('ask': Send it / Edit /
   *  Don't), or on the message it posted after approval ('sent': who approved). */
  proposal?: { id: string; kind?: 'reply' | 'task' | 'summary'; taskId?: string | null; on: 'ask' | 'sent'; state: 'pending' | 'sent' | 'dismissed' | 'expired'; body: string; sentBody: string | null; why: string | null; mine: boolean;
    approver: string | null; decidedBy: string | null; decidedAt: string | null; via: 'button' | 'reply' | null; channelId: string; channelName: string | null; postedMessageId: string | null;
    /** AI-EMP-2 (1056): time-critical (reminders don't wait for working hours), reminded once, then asked of someone else. */
    urgent?: boolean; reminded?: boolean; escalatedTo?: string | null; askedOfMe?: boolean } | null;
  agentAsk?: { state: 'queued' | 'leased' | 'dispatching' | 'done' | 'failed' | 'uncertain'; reason: string | null; agent: string; runtimeState?: string; runtimeUntil?: string | null } | null;
  /** EST-1035: a hand-off the co-worker proposed on this answer; it becomes work only when a leader accepts it. */
  handoff?: { id: string; title: string; details: string; state: 'proposed' | 'accepted' | 'declined' | 'filing' | 'filed' | 'uncertain' | 'closed'; reason: string | null; boardRef: string | null } | null;
  handoffUpdate?: { state: 'started' | 'progress' | 'in_review' | 'blocked' | 'cancelled'; boardRef: string } | null;
  /** CHAT-V3: pinned on top of the conversation, forwarded from another chat, saved by me, the thread's last reply, a
   *  comment on a point of a picture (its thread reply), an approval asked on it. */
  pinnedAt?: string | null; forwarded?: boolean; starred?: boolean; lastReplyAt?: string | null;
  annotation?: { fileId: string; x: number; y: number; resolved: boolean } | null;
  approval?: { state: 'waiting' | 'approved' | 'changes'; askedBy: string; askedByName: string; decidedBy?: string | null; decidedByName: string | null; decidedAt: string | null; note: string | null; rounds: number } | null;
  createdAt: string; editedAt: string | null; removed: boolean; replies: number; attachments: Attachment[]; mentions: string[]; reactions: { emoji: string; count: number; mine: boolean }[];
  /** Client-only: an optimistic message still on its way, or one that failed to send. */
  pending?: boolean; failed?: string; clientId?: string;
  /** CHAT-V3: waiting in this browser's outbox for the connection to come back (sent by itself then). */
  queued?: boolean;
  /** CHAT-V5: my own reminder waiting on this message. */
  reminder?: { id: string; at: string } | null;
  /** CHAT-V5: a poll asked with this message (its words are the question): choices, and votes as [choice, person]. */
  poll?: { options: string[]; multi: boolean; closed: boolean; createdBy: string; votes: [number, string][] } | null };
export type Receipts = { readThrough: string | null; deliveredThrough: string | null };
export type Connections = { email: { connected: boolean; sendEnabled?: boolean }; telegram: { enabled: boolean; connected: boolean }; whatsapp: { enabled: boolean; connected: boolean } };
/** People who have probably left (waiting for HR) are offered only when searched for: `searchOnly`. */
export type ChatData = { boardUrl?: string | null; channels: Channel[];
  /** CHAT-V5: how many of my threads have replies I have not read. */
  threadsUnread?: number;
  /** GROUP-ACCESS (1098): who reads client groups here (members, leaders, staff) and whether that opens any to me. */
  clientGroups?: { readers: "members" | "leaders" | "staff"; eligible: boolean }; people: Member[]; searchOnly?: Member[]; viewer: string; canModerate: boolean; canLead?: boolean; canImport?: boolean; retentionDays: number; policy?: { editMinutes: number; removeHours: number }; connections?: Connections };
export type FormerMember = { id: string; name: string; photoAt: string | null; leftAt: string; reason: "left_company" | "leaving_checklist" };
export type Reader = { id: string; at: string | null };
export type Thread = { messages: ChatMessage[]; hasMore: boolean; members: Member[]; formerMembers?: FormerMember[]; receipts: Receipts | null; at: number;
  /** CHAT-V3: how far each other member has read (small groups and direct chats), and the pinned messages. */
  readers?: Reader[]; pinned?: ChatMessage[] };
export type TaskCardData = { id: string; title: string; status: string; statusLabel: string; priority?: string; assigneeId: string | null; assigneeName: string | null; assigneePhotoAt: string | null; dueOn: string | null; projectName: string | null; canFollow: boolean; followedIn: string[];
  /** CHAT-WORK: who answers it in which chat, and where an AI employee's work on it stands (as Pulse recorded it). */
  assigneeAgent?: boolean; handshakes?: TaskHandshake[]; reviewerId?: string | null; canApprove?: boolean;
  agentWork?: { state: 'queued' | 'leased' | 'dispatching' | 'done' | 'failed' | 'uncertain'; reason: string | null; agent: string; at: string; runtimeState?: string; runtimeUntil?: string | null; retryAt?: string | null } | null };
export type TaskHandshake = { channelId: string; state: 'waiting' | 'accepted' | 'declined' | 'question'; personId: string; personName: string; askedBy: string; note: string | null };
/** CHAT-V5: a thread I am in, for the Threads inbox. */
export type ThreadItem = { rootId: string; channelId: string; rootAuthorId: string; rootName: string; rootBody: string; rootFiles: number; rootRemoved: boolean;
  replies: number; lastAt: string; lastName: string | null; lastAuthorId: string | null; lastBody: string | null; unread: number };
/** CHAT-V5: a message of mine waiting to be sent (or one that could not be sent at its time). */
export type ScheduledItem = { id: string; channelId: string; body: string; attachments: Attachment[]; quoteId: string | null; parentId: string | null; at: string; error: string | null; failed: boolean };
/** CHAT-V6: a reminder of mine, waiting or rung and not seen yet (the "Reminders and scheduled" screen). */
export type ReminderItem = { id: string; channelId: string; messageId: string; parentId: string | null; at: string; fired: boolean; name: string; authorId: string; body: string };
