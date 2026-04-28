/**
 * One-time OAuth2 setup script.
 * Run with: node auth-setup.js
 * Follow the URL prompt, paste the code, and copy the refresh token into your environment.
 */

import { google } from "googleapis";
import readline from "readline";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "\nMissing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.\n" +
      "Set them first, then run: node auth-setup.js\n"
  );
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  // directory.readonly: People API fallback for `users/<id>` → name resolution.
  // Required for DM partner names (members.list omits displayName under user
  // auth) and for resolving orphan senders never @mentioned in our spaces.
  "https://www.googleapis.com/auth/directory.readonly",
];

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  "urn:ietf:wg:oauth:2.0:oob" // out-of-band for desktop apps
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent", // force refresh_token to be returned
});

console.log("\n=== Google Chat OAuth2 Setup ===\n");
console.log("1. Open this URL in your browser:\n");
console.log("   " + authUrl);
console.log("\n2. Sign in and grant access.");
console.log("3. Copy the authorisation code and paste it below.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Authorisation code: ", async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log("\n=== Success! ===\n");
    console.log("Your GOOGLE_REFRESH_TOKEN:\n");
    console.log(tokens.refresh_token);
    console.log("\nUse this token when adding the MCP server to Claude Code (see README).\n");
  } catch (err) {
    console.error("Failed to exchange code:", err.message);
  }
});
