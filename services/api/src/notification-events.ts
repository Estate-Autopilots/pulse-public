/** Versioned server event/deep-link contract. Authorization is always rechecked by the database. */
export const NOTIFICATION_EVENTS = {
 'update.self':'MyDesk','chat.message':'Chats','chat.mention':'Chats','chat.reply':'Chats',
 'policy.published':'Policies','holiday.announced':'Holidays','task.assigned':'Tasks',
 'task.blocked':'Tasks','task.unblocked':'Tasks','task.due_soon':'Tasks','task.done':'Tasks','task.accepted':'Tasks',
 'task.ask':'Tasks','project.ask':'Tasks','ask.answered':'Tasks','task.mention':'Tasks','project.mention':'Tasks',
 'task.comment':'Tasks','project.comment':'Tasks','project.added':'Tasks','task.update':'Tasks',
 // UX-5B: Pulse finished your task (Undo is on it); someone waits on your task.
 'task.auto_done':'Tasks','task.waiting':'Tasks',
 'leave.decision':'Approvals','request.updated':'Approvals','request.decision':'Approvals',
 'approval.waiting':'Approvals','approval.reminder':'Approvals','payroll.processed':'Payroll',
 'attendance.start':'MyDesk','attendance.end':'MyDesk','attendance.done':'MyDesk',
 'attendance.departure':'MyDesk','attendance.confirmed':'MyDesk',
 // POLISH-2 (QA-E2E P2-3): the arrival question, the break and HR's nudge open My desk from the phone too.
 'attendance.arrival':'MyDesk','attendance.break':'MyDesk','attendance.nudge':'MyDesk','attendance.checkout':'MyDesk',
 // ATT: one daily digest of HR requests per approver; the attendance question, automatic check-in/out, HR's digest.
 'approval.digest':'Approvals','attendance.ask':'MyDesk','attendance.auto':'MyDesk','attendance.digest':'MyDesk',
} as const;
export type NotificationEventType=keyof typeof NOTIFICATION_EVENTS;
export type NotificationEvent={version:1;id:string;eventType:NotificationEventType;subject:{type:'person'|'message'|'hr_flow'|'task'|'policy'|'holiday'|'payroll_notice'|'project'|'work_ask'|'comment';id:string};href:string;expiresAt:string};
export function notificationTarget(eventType:unknown):typeof NOTIFICATION_EVENTS[NotificationEventType]|null {
 return typeof eventType==='string'&&Object.hasOwn(NOTIFICATION_EVENTS,eventType)?NOTIFICATION_EVENTS[eventType as NotificationEventType]:null;
}
