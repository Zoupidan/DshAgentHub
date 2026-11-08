/**
 * 成员 scope 的工具装配（qoder）。
 * @module host/team/member-tools
 */
import { PLUGIN_ID } from '../../shared/constants.js';
import { makeRunTool } from '../tools/run.js';
import { makeStatusTool } from '../tools/status.js';

export const MEMBER_DUTY_TEXT = 'You are the Qoder member of this Agent Team: the team\'s Qoder (CN desktop) work runs through you. '
  + 'Use qoder_run to send a task to the local Qoder desktop app via CDP+applicationInvoke — the conversation is a real session visible in the desktop UI; '
  + 'read receipts before replying and relay results to the Lead verbatim with send_message. When the Lead messages an objection, argue back on the next run under the same session_key. '
  + 'Never implement the delegated task yourself. Never claim scheduled_tasks/plan automation (unsupported). Approval relay is unknown/unverified — report it as unknown, do not fabricate.';

export function installMemberTools(scoped, deps) {
  const disposers = [];
  try {
    disposers.push(scoped.tools.register(makeRunTool(deps.runtime, deps.sessions, deps.read, deps.ctx, deps.dispatch ?? null)));
    disposers.push(scoped.tools.register(makeStatusTool(deps.runtime, deps.sessions, deps.read, deps.dispatch ?? null)));
    disposers.push(scoped.systemPrompt.section({ name: `${PLUGIN_ID}:member-duty`, order: 521, text: MEMBER_DUTY_TEXT }));
  } catch (err) {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
    throw err;
  }
  return () => { for (const dispose of disposers.reverse()) { try { dispose(); } catch {} } };
}
