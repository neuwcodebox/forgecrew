export type Issue = {
  number: number;
  body: string | null;
  pull_request?: unknown;
  labels: (string | { name?: string })[];
  user: { login: string } | null;
};
export type LabelEvent = {
  id: number;
  event: string;
  created_at: string;
  actor: { login: string } | null;
  label?: { name: string };
};
export type Comment = {
  id: number;
  body?: string;
  created_at: string;
  updated_at: string;
  user: { login: string; id: number } | null;
  issue_url?: string;
  pull_request_url?: string;
};
export type Review = {
  id: number;
  body: string | null;
  submitted_at: string | null;
  state: string;
  user: { login: string; id: number } | null;
};
export interface GitHubSource {
  issues(repository: string, since: string): Promise<Issue[]>;
  events(repository: string, number: number): Promise<LabelEvent[]>;
  comments(repository: string, since: string, review: boolean): Promise<Comment[]>;
  permission(repository: string, login: string): Promise<boolean>;
  reviews?(repository: string, number: number): Promise<Review[]>;
  syncLabels?(
    repository: string,
    number: number,
    desired: string[],
    prefixes: string[],
  ): Promise<void>;
}
