interface Repo {
  find(id: number): string | undefined;
}

export const memRepo: Repo = {
  find: (id) => (id > 0 ? lookup(id) : undefined),
};

function lookup(id: number) {
  return String(id);
}

const logger = console; // a value from elsewhere, not a step

function audit(msg: string) {
  logger.log(msg);
}

export function handle(repo: Repo, id: number) {
  const v = repo.find(id);
  if (!v) audit("miss");
  return format(v ?? "");
}

const format = (s: string) => s.trim();
