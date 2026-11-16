-- migrate:up
-- AI-CONNECT (8 Nov 2026): contracts and goals could not be written through API v1, MCP or the CLI. Every v1 write
-- records itself in the change ledger (pulse_priv.app_change, services/api/src/v1-kit.ts `change`), and
-- app_change_action_check only lets the listed actions in. 1583 (contracts) listed contract.* and goal.* (and
-- connector.tool); 1596 (AI-employee API, written before 1583 and renumbered after it) re-made the check from the older
-- list, and 1621 copied that, so create_contract, update_contract, send/accept/link/transactions and every goal write
-- answered 400 "The request was refused" (23514) and rolled back. Found by a real Claude Code run (reports/AI-CONNECT.md).
-- This puts back the union of 1621 and 1583. services/api/test/app-change-actions.test.mjs keeps code and check equal.
alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request',
  'ai_employee.create', 'ai_employee.update', 'ai_employee.cap', 'ai_employee.key.create', 'ai_employee.key.revoke',
  'server.job',
  'connector.tool',
  'contract.create', 'contract.update', 'contract.send', 'contract.accept', 'contract.end', 'contract.txn', 'contract.link',
  'goal.create', 'goal.update', 'goal.link', 'goal.unlink'));

-- migrate:down
alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request',
  'ai_employee.create', 'ai_employee.update', 'ai_employee.cap', 'ai_employee.key.create', 'ai_employee.key.revoke',
  'server.job')) not valid;
