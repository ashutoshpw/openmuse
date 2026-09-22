export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "forbidden" | "conflict" | "expired" | "invalid",
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}
