export type Opened = {
  thread: { id: string };
  model: string;
  approvalsReviewer: string;
  approvalPolicy: unknown;
  sandbox: { type: string };
  reasoningEffort?: string | null;
};

export type NotificationParams = {
  threadId?: string;
  turn?: { id: string; status?: string; error?: { codexErrorInfo?: string } };
  item?: { type: string; phase?: string; text: string };
  questions?: unknown;
};
