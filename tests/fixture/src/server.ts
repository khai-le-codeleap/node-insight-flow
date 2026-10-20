import { checkToken } from "./auth";

type Handler = (req: string) => string;

class Router {
  routes: [string, Handler[]][] = [];
  use(mw: Handler) {
    return this;
  }
  get(path: string, ...hs: Handler[]) {
    this.routes.push([path, hs]);
    return this;
  }
}

class Group {
  handle(name: string, f: () => string) {
    return this;
  }
  middleware(m: Handler) {
    return this;
  }
}

const group = (name: string, f: (g: Group) => Group) => f(new Group());

export function requireAuth(req: string) {
  return req;
}

export function showProfile(req: string) {
  return req.toUpperCase();
}

// Express-style: middleware registered on the same router object.
export const router = new Router();
router.use(requireAuth);
router.use(checkToken);
router.get("/profile", requireAuth, checkToken, showProfile);

// Builder-style: the handler sits inside a group that gets a middleware.
export const webGroup = group("web", (g) => g.handle("profile", () => showProfile("x"))).middleware(requireAuth);
export const server = [webGroup];
