// What makes an acceptable username and password. Kept plain: length matters far more than symbols.

export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;

export const normalizeUsername = (u: string): string => u.trim().toLowerCase();

export function checkUsername(username: string): string | null {
  if (!USERNAME.test(username)) return "A username is 3 to 30 letters, numbers, dots, dashes or underscores, and starts with a letter or number.";
  return null;
}

const COMMON = new Set([
  "password", "password1", "password123", "passw0rd", "123456789", "1234567890", "12345678910", "qwertyuiop", "qwerty12345", "iloveyou123",
  "welcome123", "welcome1234", "admin12345", "letmein1234", "changeme123", "dawnoffaith", "dawnoffaith1", "productionhub", "abcd123456", "111111111111",
]);

/** Returns why a password is not acceptable, or null if it is. */
export function checkPassword(password: string, context: { username?: string; name?: string } = {}): string | null {
  if (password.length < 10) return "Use at least 10 characters. A few words together make a good password.";
  if (password.length > 128) return "That password is too long. Use at most 128 characters.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "That password is too common. Choose something less guessable.";
  if (/^(.)\1+$/.test(password)) return "That password repeats one character. Choose something less guessable.";
  if (context.username && lower.includes(context.username.toLowerCase())) return "The password should not contain your username.";
  const first = context.name?.split(" ")[0]?.toLowerCase();
  if (first && first.length >= 4 && lower.includes(first)) return "The password should not contain your name.";
  return null;
}
