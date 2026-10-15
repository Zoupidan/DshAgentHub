/**
 * 回执抽取 —— 从服务端**结构化事实**里组装本轮结论。
 *
 * 判据纪律（承接 plugin-workbuddy 的教训：不读模型正文猜成败）：
 *   - 成败看 `Session.Info.outcome`（'succeeded'|'failed'|'interrupted'），不看 reply 文本。
 *   - 正文取**本轮**的 assistant 消息：按 prompt 受理的 inboxId 定位（消息表 desc 序里
 *     inboxId 之前的第一条 assistant），拿不到就退到最新一条 assistant —— 拿不到则如实报 null。
 *   - 消息形状 [实测]（recon §11）：assistant 的正文在 `content[]` 的 `{type:'text'}` 块里
 *     （**不是** `parts[]`）。
 *
 * @module host/gateway/receipt
 */
import { REPLY_LIMIT_CHARS } from '../config/constants.js';

/** 消息类型（服务端 type 字段；`Session.Message` 判别式）。 */
export function messageType(message) {
  return typeof message?.type === 'string' ? message.type : (typeof message?.role === 'string' ? message.role : '');
}

/** 拼接 content[] 里的全部文本块（丢掉 reasoning 等其它块）。 */
export function extractText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : (Array.isArray(message?.parts) ? message.parts : []);
  const texts = [];
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      texts.push(block.text);
    }
  }
  return texts.join('\n');
}

/**
 * 找本轮的 assistant 消息。
 * @param {any[]} messages 消息表（desc：新在前）
 * @param {string} inboxId prompt 受理回执的 id（'' = 未知 ⇒ 取最新一条 assistant）
 */
export function pickAssistantMessage(messages, inboxId) {
  const list = Array.isArray(messages) ? messages : [];
  const anchorIndex = inboxId === '' ? -1 : list.findIndex((m) => (m?.id ?? m?.info?.id) === inboxId);
  if (anchorIndex >= 0) {
    // desc 序：inboxId 之后的（更新的）消息都在它**前面**。
    for (let i = 0; i < anchorIndex; i += 1) {
      if (messageType(list[i]) === 'assistant') return list[i];
    }
  }
  // 兜底：最新一条 assistant（可能是上一轮的 —— 由调用方结合 outcome/时间进一步判读）。
  return list.find((m) => messageType(m) === 'assistant') ?? null;
}

/** 截断正文（带标志；截断即如实标注）。 */
export function truncateReply(text) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= REPLY_LIMIT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, REPLY_LIMIT_CHARS), truncated: true };
}

/**
 * 组装回执。
 * @param {{session: any, messages: any[], inboxId: string}} input
 * @returns {{outcome: string|null, reply: string, replyTruncated: boolean, finish: string|null,
 *   tokens: {input: number, output: number, reasoning: number}|null,
 *   cost: number|null, model: {id: string, providerID: string, variant: string}|null,
 *   assistantMessageId: string|null, anchored: boolean}}
 */
export function buildReceipt({ session, messages, inboxId = '' }) {
  const assistant = pickAssistantMessage(messages, inboxId);
  const anchorIndex = inboxId === '' ? -1 : (Array.isArray(messages) ? messages.findIndex((m) => (m?.id ?? m?.info?.id) === inboxId) : -1);
  const { text, truncated } = truncateReply(assistant === null ? '' : extractText(assistant));
  const t = assistant?.tokens;
  const tokens = t !== null && typeof t === 'object'
    ? {
      input: typeof t.input === 'number' ? t.input : 0,
      output: typeof t.output === 'number' ? t.output : 0,
      reasoning: typeof t.reasoning === 'number' ? t.reasoning : 0,
    }
    : null;
  const model = session?.model !== null && typeof session?.model === 'object' && typeof session.model.id === 'string'
    ? {
      id: session.model.id,
      providerID: typeof session.model.providerID === 'string' ? session.model.providerID : '',
      variant: typeof session.model.variant === 'string' ? session.model.variant : '',
    }
    : null;
  return {
    outcome: typeof session?.outcome === 'string' ? session.outcome : null,
    reply: text,
    replyTruncated: truncated,
    finish: typeof assistant?.finish === 'string' ? assistant.finish : null,
    tokens,
    // ★ cost 与 tokens 同源优先：live 探针里两者都挂在**本轮 assistant 消息**上（recon §11）；
    //   会话层也允许带 cost（不同版本可能挪位置）⇒ 消息优先、会话兜底。
    cost: typeof assistant?.cost === 'number'
      ? assistant.cost
      : (typeof session?.cost === 'number' ? session.cost : null),
    model,
    assistantMessageId: typeof assistant?.id === 'string' ? assistant.id : null,
    anchored: anchorIndex >= 0,
  };
}
