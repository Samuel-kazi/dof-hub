/** An error that becomes an HTTP answer. The message is safe to show to the person. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
