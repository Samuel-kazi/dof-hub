// Turns a MongoDB connection failure into a plain sentence saying what to check.
// Only the kind of problem is described, never the connection string, the password or the address.

export function describeDbProblem(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  const text = e instanceof Error ? `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ""}` : String(e);
  const code = (e as { code?: number | string }).code;
  if (code === 18 || /bad auth|authentication failed|AuthenticationFailed/i.test(text))
    return "MongoDB refused the username or password in MONGODB_URI. If the password has symbols such as @ : / ? # or %, they must be URL-encoded. The simplest fix is to reset the database user's password to letters and numbers only, then update MONGODB_URI in Vercel and redeploy.";
  if (name === "MongoParseError" || /invalid scheme|invalid connection string|must be a string|URI malformed|Invalid namespace/i.test(text))
    return "MONGODB_URI is not a valid connection string. It should start with mongodb+srv:// and be copied whole from Atlas (Connect, Drivers), with <password> replaced by the real password and no spaces or quotes.";
  if (/ENOTFOUND|querySrv|EBADNAME/i.test(text))
    return "The cluster address in MONGODB_URI was not found. Copy the connection string again from Atlas (Connect, Drivers).";
  if (name === "MongoServerSelectionError" || /ECONNREFUSED|ETIMEDOUT|timed out|Server selection/i.test(text))
    return "The server could not reach MongoDB. In Atlas, Network Access must allow 0.0.0.0/0 (Vercel's addresses change), and the cluster must not be paused. Wait a minute after changing either, then try again.";
  if (/not authorized|Unauthorized|requires authentication/i.test(text))
    return "The database user in MONGODB_URI is not allowed to use this database. In Atlas, Database Access, give the user the role \"Read and write to any database\", or read and write on the database named in MONGODB_DB.";
  return `The database could not be reached${name ? ` (${name})` : ""}. The details are in the Vercel logs for this deployment.`;
}
