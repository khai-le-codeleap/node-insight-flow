/** Load a user by id. */
export function getUser(id: number) {
  return { id, name: "u" + id };
}

export default function createUser() {
  return getUser(0);
}
