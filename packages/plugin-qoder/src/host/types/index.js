/**
 * host 端类型（JSDoc typedef）—— 纯文档，无运行时代码。形状即契约。
 *
 * 证据分级：字段必要性来自 `04-docs/qoder/14/15` 与 CHARTER §4。
 */

/**
 * @typedef {Object} ProbeEvidence
 * @property {number} at
 * @property {string} method
 * @property {string} target
 * @property {string} detail （不得含凭据）
 */

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} installed CDP 可达且命中 Qoder 目标
 * @property {string} reason 'ok'|'cdp-unavailable'|'target-not-found'|'bridge-error'|'error'
 * @property {string} baseUrl http://127.0.0.1:<port>
 * @property {string} targetId CDP target id
 * @property {string} targetUrl 目标页 URL
 * @property {string} targetTitle 目标页标题
 * @property {string} endpointId Qoder authorityEndpointId（''=未知）
 * @property {ProbeEvidence[]} evidence
 * @property {number} at
 */

/**
 * @typedef {Object} ProbeState
 * @property {'idle'|'pending'|'done'} status
 * @property {string} target
 * @property {ProbeResult|null} result
 * @property {string} pendingReason
 */

/**
 * @typedef {Object} RunRecord
 * @property {string} sessionKey
 * @property {string} sessionId
 * @property {number} startedAt
 * @property {string} phase
 */

/**
 * @typedef {Object} LastRunRecord
 * @property {string} sessionId
 * @property {string} sessionKey
 * @property {boolean} resumed
 * @property {string} promptExcerpt
 * @property {number|null} acceptedAt
 * @property {number|null} idleAt
 * @property {string|null} waitStatus
 * @property {string|null} outcome
 * @property {string} reply
 * @property {{modelKey: string, reasoningEffort: string, contextWindow: number}|null} model
 * @property {string} reasonCode
 * @property {string} reasonText
 * @property {string} reasonEvidence
 * @property {number} at
 */

/** @typedef {{id:string,sessionId:string,title:string,workspacePath:string,lastUsedAt:number,own:boolean,state:string}} SessionSummaryRow */

export {};
