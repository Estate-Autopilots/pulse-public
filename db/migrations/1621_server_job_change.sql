-- migrate:up
-- AI-EMPLOYEE-POWER hotfix (6 Nov 2026). run_on_server still answered 400 in production after a183e163 (request
-- 9dafcaec-…, 14:55 UTC): the handler records each job in the change ledger as action 'server.job', and
-- app_change_action_check (last set in 1596) does not list it, so the insert failed with 23514 and the job rolled back.
-- (a183e163 fixed the first failure on the same line, the job id as the uuid subject; this check came right after it.)
alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request',
  'ai_employee.create', 'ai_employee.update', 'ai_employee.cap', 'ai_employee.key.create', 'ai_employee.key.revoke',
  'server.job'));

-- migrate:down
alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request',
  'ai_employee.create', 'ai_employee.update', 'ai_employee.cap', 'ai_employee.key.create', 'ai_employee.key.revoke')) not valid;
