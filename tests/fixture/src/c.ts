import { getUser } from "@lib/user";
import make from "./lib/user";

export const c = [1].map(getUser);
export const d = make();
const bad: string = 1;
