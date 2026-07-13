import { IMessageSDK, IMessageError } from "@photon-ai/imessage-kit";

/**
 * The SDK opens ~/Library/Messages/chat.db in its constructor. When that
 * fails it's almost always missing Full Disk Access, so surface the fix
 * instead of a raw stack trace.
 */
export function explainSdkError(err: unknown): string | null {
  if (err instanceof IMessageError && (err.code === "DATABASE" || err.code === "PLATFORM")) {
    return [
      `cannot open the iMessage database (${err.message}).`,
      "grant Full Disk Access to your terminal / Node process:",
      "  System Settings → Privacy & Security → Full Disk Access",
      "then restart the bridge.",
    ].join("\n");
  }
  return null;
}

function createSdk(): IMessageSDK {
  try {
    return new IMessageSDK();
  } catch (err) {
    const hint = explainSdkError(err);
    if (hint) {
      console.error(hint);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Single shared SDK instance — the listener (polls chat.db) and the sender
 * (Express /send) must not each open their own database handle.
 */
export const sdk = createSdk();
