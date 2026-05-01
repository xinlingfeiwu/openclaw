import { createHash } from "node:crypto";

// Copilot's OpenAI-compatible `/responses` endpoint can emit replay item IDs
// and reasoning `encrypted_content` blobs that encode upstream connection state.
// Both are rejected after the connection changes, so normalize them at the
// provider boundary before send.

function looksLikeConnectionBoundId(id: string): boolean {
  if (id.length < 24) {
    return false;
  }
  if (/^(?:rs|msg|fc)_[A-Za-z0-9_-]+$/.test(id)) {
    return false;
  }
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(id)) {
    return false;
  }
  return Buffer.from(id, "base64").length >= 16;
}

function deriveReplacementId(type: string | undefined, originalId: string): string {
  const prefix = type === "function_call" ? "fc" : "msg";
  const hex = createHash("sha256").update(originalId).digest("hex").slice(0, 16);
  return `${prefix}_${hex}`;
}

type InputItem = Record<string, unknown> & { id?: unknown; type?: unknown };

export function rewriteCopilotConnectionBoundResponseIds(input: unknown): boolean {
  if (!Array.isArray(input)) {
    return false;
  }
  let rewrote = false;
  for (const item of input as InputItem[]) {
    const id = item.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    // Reasoning items always reference server-side encrypted state bound to the
    // original item ID. Rewriting the ID — even when encrypted_content is absent
    // or null — breaks Copilot's server-side lookup and causes a 400 validation
    // failure regardless of whether the client included encrypted_content.
    if (item.type === "reasoning") {
      continue;
    }
    if (looksLikeConnectionBoundId(id)) {
      item.id = deriveReplacementId(typeof item.type === "string" ? item.type : undefined, id);
      rewrote = true;
    }
    // encrypted_content blobs are cryptographically bound to the originating
    // connection's internal item ID. After any connection change the blob
    // verification fails with a 400, regardless of whether the public item ID
    // was rewritten above. Strip them unconditionally for reasoning items so
    // the server always receives a clean context.
    if (item.type === "reasoning" && "encrypted_content" in item) {
      delete item.encrypted_content;
    }
  }
  return rewrote;
}

export function rewriteCopilotResponsePayloadConnectionBoundIds(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return rewriteCopilotConnectionBoundResponseIds((payload as { input?: unknown }).input);
}
