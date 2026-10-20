// list_apis fixture: an express-like route, a client call, a named endpoint with its handler, a decorated controller.
type Handler = (...args: unknown[]) => unknown;
const app = { get(path: string, ...h: Handler[]) {}, post(path: string, ...h: Handler[]) {} };
const http = { get(path: string, opts?: object) {} };
const requireUser: Handler = () => {};
export function listUsers() {
  return [];
}

app.get("/users", requireUser, listUsers);
http.get("/not-a-route", {});

type Names = "getUser";
const Endpoint = { get<N extends Names>(name: N, path: string) { return { name, path }; } };
const group = { add(..._e: unknown[]) { return group; }, prefix(_p: string) { return group; } };
export const Api = group.add(Endpoint.get("getUser", "/users/:id")).prefix("/v1");
const handlers = { handle(_name: Names, _fn: Handler) { return handlers; } };
handlers.handle("getUser", () => listUsers());

const Controller = (_p: string) => (..._a: unknown[]) => {};
const Post = (_p?: string) => (..._a: unknown[]) => {};
@Controller("/admin")
export class AdminController {
  @Post("reset")
  reset() {}
}
