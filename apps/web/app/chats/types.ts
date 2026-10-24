export type Member = { id: string; name: string; username: string | null; pod?: string | null; team?: string | null; role?: 'member' | 'admin'; photoAt?: string | null;
  /** EST-1035: an AI co-worker (leaders see them; it answers in seconds and real work becomes a task). */
  agent?: boolean; employeeId?: string | null };
export type ChannelKind = 'pod' | 'team' | 'group' | 'direct' | 'custom';
/** CHAT-VOICE: `voice` marks a file as a voice note: its length in seconds and its waveform (bars 4–100). */
export type Attachment = { id?: string; name: string; url?: string; mime?: string; task?: string; voice?: { seconds: number; peaks: number[] };
  /** CHAT-V3: a new version of an earlier picture or file (revision rounds): its number and the message it replaces. */
  version?: number; prev?: string;
  /** CHAT-V3: an event line's link to the message it is about (pinned, an approval asked or answered). */
  pinned?: string; approval?: string;
  /** CHAT-VOICE: a call's line in the conversation (kind 'event'). */
  call?: string; video?: boolean; state?: string; seconds?: number | null };
export type Channel = { id: string; moderationOnly?:boolean; name: string; kind: ChannelKind; description: string; address: string | null; unread: number; mentions?:number; members: number; lastAt: string | null;
  preview?: string | null; previewAuthor?: string | null; previewAuthorId?: string | null; previewKind?: string | null; previewRemoved?: boolean | null; previewAttachment?: Attachment | null; duplicateOf?: string | null;
  photoAt?: string | null; peerId?: string | null; peerFormer?: boolean; peerAgent?: boolean; peerPhotoAt?: string | null; peerUsername?: string | null; peerDepartment?: string | null; pinnedAt?: string | null; myRole?: 'member' | 'admin' | null;
  /** R47: imported WhatsApp history this member can read (groups people made and direct chats only). */
  imported?: number;
  /** CONNECT: shared with another organisation through a connection: its name ("with <organisation>"). */
  withOrg?: string | null;
  /** CHAT-V3: my own settings for this chat (muted until, archived), and whether people outside the company are in it. */
  mutedUntil?: string | null; archivedAt?: string | null; clientFacing?: boolean };
export type Quote = { id: string; authorId: string; name: string; body: string; removed: boolean; attachments: number };
export type ChatMessage = { id: string; channelId: string; authorId: string; name: string; username: string | null; photoAt?: string | null; body: string; parentId: string | null; quoteId?: string | null; quote?: Quote | null; kind?: 'text' | 'event';
  /** LIFECYCLE: the author is no longer in this conversation (left the company, or the pod or team). */
  former?: boolean;
  /** EST-1035: written by an AI co-worker; its run as the model reported it (tokens null: not reported, shown as unknown). */
  byAgent?: boolean; employeeId?: string | null;
  agentRun?: { lane: string; model: string; tokens: number | null; seconds: number | string | null; state: 'dispatching' | 'done' | 'error' | 'uncertain' } | null;
  /** EST-1035: a leader's question to a co-worker, and where its answer stands. */
  /** AI-EMPLOYEES v2: an AI employee's proposal: on the direct message asking its approver ('ask': Send it / Edit /
   *  Don't), or on the message it posted after approval ('sent': who approved). */
  proposal?: { id: string; kind?: 'reply' | 'task' | 'summary'; taskId?: string | null; on: 'ask' | 'sent'; state: 'pending' | 'sent' | 'dismissed' | 'expired'; body: string; sentBody: string | null; why: string | null; mine: boolean;
    approver: string | null; decidedBy: string | null; decidedAt: string | null; via: 'button' | 'reply' | null; channelId: string; channelName: string | null; postedMessageId: string | null } | null;
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
  queued?: boolean };
export type Receipts = { readThrough: string | null; deliveredThrough: string | null };
export type Connections = { email: { connected: boolean; sendEnabled?: boolean }; telegram: { enabled: boolean; connected: boolean }; whatsapp: { enabled: boolean; connected: boolean } };
/** People who have probably left (waiting for HR) are offered only when searched for: `searchOnly`. */
export type ChatData = { boardUrl?: string | null; channels: Channel[]; people: Member[]; searchOnly?: Member[]; viewer: string; canModerate: boolean; canLead?: boolean; canImport?: boolean; retentionDays: number; policy?: { editMinutes: number; removeHours: number }; connections?: Connections };
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
