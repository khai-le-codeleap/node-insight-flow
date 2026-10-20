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

class NotFound extends Error {
  constructor(readonly id: number) {
    super(describe(id));
  }
}

function describe(id: number) {
  return `missing ${id}`;
}

export function must(repo: Repo, id: number) {
  const v = repo.find(id);
  if (v === undefined) throw new NotFound(id);
  return v;
}

export function checkout(repo: Repo, ids: number[]) {
  const first = must(repo, ids[0]);
  for (const id of ids) {
    audit(String(id));
  }
  if (first.length > 3) {
    return format(first);
  }
  try {
    lookup(ids.length);
  } catch {
    audit("lookup failed");
  }
  return first;
}

function run<T>(f: () => T): T {
  return f();
}

export function withCallback(repo: Repo) {
  const v = run(() => {
    if (repo.find(1)) return "hit";
    return lookup(2);
  });
  return format(v);
}
