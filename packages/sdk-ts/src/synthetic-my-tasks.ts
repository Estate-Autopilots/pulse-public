/** Contract from openapi/synthetic-my-tasks.yaml. Acceptance harness only; absent from the install API. */
export const SYNTHETIC_MY_TASKS_PATH = '/synthetic/my-tasks' as const;
export interface SyntheticMyTask {
  organization: string;
  title: string;
  status: string;
  dueAt: string | null;
}
export type SyntheticMyTasksResponse = SyntheticMyTask[];
