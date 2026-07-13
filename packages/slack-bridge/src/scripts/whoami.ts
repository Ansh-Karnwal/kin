/** Validates SLACK_TEAM_ID + SLACK_JWT by asking Spectrum for the bot identity. */
import "../env.js";
import { getTeam, closeClient } from "../client.js";

const identity = await getTeam().messages.whoAmI();
console.log(JSON.stringify(identity, null, 2));
await closeClient();
