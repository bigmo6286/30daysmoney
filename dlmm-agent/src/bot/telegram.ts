/** Minimal Telegram Bot API client (long polling). Only the owner's chat is ever served. */
import { logger } from "../log";

const log = logger("tg");

export type Button = { text: string; data: string };
export type Keyboard = Button[][];

export interface Incoming {
  chatId: string;
  fromId: string;
  text?: string;
  callback?: { id: string; data: string; messageId: number };
}

export class Telegram {
  private offset = 0;
  private running = false;
  constructor(
    private readonly token: string,
    readonly ownerId: string,
    private readonly base = process.env.TG_API_BASE || "https://api.telegram.org",
  ) {}

  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(65_000),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
    return json.result;
  }

  private markup(kb?: Keyboard) {
    return kb ? { reply_markup: { inline_keyboard: kb.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {};
  }

  send(text: string, kb?: Keyboard, chatId = this.ownerId) {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...this.markup(kb),
    });
  }

  edit(messageId: number, text: string, kb?: Keyboard, chatId = this.ownerId) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...this.markup(kb),
    }).catch((e) => log.debug(`edit failed: ${(e as Error).message}`));
  }

  answer(callbackId: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: callbackId, text }).catch(() => undefined);
  }

  async start(onMessage: (m: Incoming) => Promise<void>): Promise<void> {
    this.running = true;
    while (this.running) {
      let updates: any[] = [];
      try {
        updates = await this.call<any[]>("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
      } catch (e) {
        log.warn(`poll failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        const m = toIncoming(u);
        if (!m) continue;
        // AUTH BOUNDARY: everything that isn't the configured owner is dropped silently
        if (m.fromId !== this.ownerId || m.chatId !== this.ownerId) {
          log.warn(`ignored update from ${m.fromId}`);
          continue;
        }
        onMessage(m).catch((e) => log.error(`handler crashed: ${(e as Error).message}`));
      }
    }
  }

  stop() {
    this.running = false;
  }
}

function toIncoming(u: any): Incoming | null {
  if (u.message?.text) {
    return { chatId: String(u.message.chat.id), fromId: String(u.message.from?.id), text: u.message.text };
  }
  if (u.callback_query) {
    const cq = u.callback_query;
    return {
      chatId: String(cq.message?.chat?.id),
      fromId: String(cq.from?.id),
      callback: { id: cq.id, data: cq.data ?? "", messageId: cq.message?.message_id },
    };
  }
  return null;
}
