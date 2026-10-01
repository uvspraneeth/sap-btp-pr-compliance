/**
 * Outlook-safe e-mail templates (table layout, inline CSS, VML "bulletproof"
 * buttons, no external images) + the small confirmation pages served by
 * /email-action. Every dynamic value goes through esc().
 */
import { fmtAmount } from '../util.js'

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ENTITIES[c])

const FONT = "font-family:'72','Segoe UI',Arial,sans-serif"
const COLORS = { brand: '#0070f2', positive: '#188918', negative: '#d20a0a', critical: '#e76500', neutral: '#556b82' }
const OUTCOME = { PASS: ['Passed', 'positive'], WARN: ['Passed with warnings', 'critical'], BLOCK: ['Blocked', 'negative'] }
const MODE = { ALL: 'all approvers must approve', ANY: 'first decision counts', QUORUM: 'quorum' }
const fmtDate = iso => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-')

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------
export function button({ href, label, color = COLORS.brand, width = 150 }) {
  const h = esc(href), l = esc(label)
  return `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${h}" style="height:40px;v-text-anchor:middle;width:${width}px;" arcsize="10%" stroke="f" fillcolor="${color}"><w:anchorlock/><center style="color:#ffffff;${FONT};font-size:14px;font-weight:bold;">${l}</center></v:roundrect><![endif]--><!--[if !mso]><!-- --><a href="${h}" style="background-color:${color};border-radius:4px;color:#ffffff;display:inline-block;${FONT};font-size:14px;font-weight:bold;line-height:40px;text-align:center;text-decoration:none;width:${width}px;-webkit-text-size-adjust:none;mso-hide:all;">${l}</a><!--<![endif]-->`
}

const row = (label, value) =>
  `<tr><td style="padding:6px 0;color:#556b82;${FONT};font-size:13px;width:150px;vertical-align:top;">${esc(label)}</td><td style="padding:6px 0;color:#1d2d3e;${FONT};font-size:14px;vertical-align:top;">${value}</td></tr>`

const badge = (text, tone) =>
  `<span style="color:${COLORS[tone] ?? COLORS.neutral};font-weight:bold;">${esc(text)}</span>`

export function layout({ title, preheader = '', body }) {
  return `<!DOCTYPE html><html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(title)}</title><!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]--></head>
<body style="margin:0;padding:0;background-color:#f5f6f7;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f6f7;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #d9d9d9;border-radius:8px;">
<tr><td style="background-color:#354a5f;padding:14px 24px;border-radius:8px 8px 0 0;color:#ffffff;${FONT};font-size:15px;font-weight:bold;">PR Compliance</td></tr>
<tr><td style="padding:24px;">
<h1 style="margin:0 0 16px 0;color:#1d2d3e;${FONT};font-size:20px;font-weight:bold;">${esc(title)}</h1>
${body}
</td></tr>
<tr><td style="padding:12px 24px;border-top:1px solid #eeeeee;color:#8396a8;${FONT};font-size:11px;">Automated message from PR Compliance. Links are personal, single-use and expire. Do not forward this e-mail.</td></tr>
</table></td></tr></table></body></html>`
}

const table = rows => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>`

// ---------------------------------------------------------------------------
// Mails
// ---------------------------------------------------------------------------
/**
 * @param {object} d { task, pr, po, checks[], links: { approve, reject, view }, reminder }
 */
export function approvalRequestMail(d) {
  const { task, pr = {}, po, checks = [], links, reminder } = d
  const amount = fmtAmount(po?.totalAmount ?? pr.totalAmount, po?.currency_code ?? pr.currency_code)
  const doc = task.kind === 'VARIANCE' ? `PO ${po?.poNumber ?? ''} variance` : `${pr.prNumber ?? 'PR'}`
  const subject = `${reminder ? 'Reminder: ' : ''}Approval required: ${doc} - ${pr.title ?? ''} (${amount})`.slice(0, 200)
  const [outcomeText, tone] = OUTCOME[pr.complianceOutcome] ?? ['Not checked', 'neutral']
  const issues = checks.filter(c => c.result !== 'PASS')

  const rows = [
    row('Request', `<b>${esc(pr.prNumber)}</b> &ndash; ${esc(pr.title)}`),
    task.kind === 'VARIANCE' ? row('Purchase Order', esc(po?.poNumber)) : '',
    row('Amount', `<b>${esc(amount)}</b>`),
    row('Requester', esc(pr.requesterName)),
    row('Vendor', esc(pr.vendorName)),
    row('Cost center', esc(pr.costCenter_code)),
    row('Approval step', `Level ${esc(task.level)} &ndash; ${esc(task.levelName)} <span style="color:#556b82;">(${esc(MODE[task.levelMode] ?? task.levelMode ?? '')})</span>`),
    row('Due', esc(fmtDate(task.dueAt))),
    row('Compliance', badge(outcomeText, tone))
  ]
  const issueList = issues.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0;background-color:#fff8e6;border-left:4px solid ${COLORS.critical};"><tr><td style="padding:10px 12px;${FONT};font-size:13px;color:#1d2d3e;">${issues
        .map(c => `<b>${esc(c.checkType)}</b> (${esc(c.result)}): ${esc(c.message)}`)
        .join('<br>')}</td></tr></table>`
    : ''
  const justification = pr.justification
    ? `<p style="margin:12px 0;${FONT};font-size:13px;color:#1d2d3e;"><b>Justification:</b> ${esc(pr.justification)}</p>`
    : ''
  const buttons = links.approve
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;"><tr><td style="padding-right:10px;">${button({ href: links.approve, label: 'Approve', color: COLORS.positive })}</td><td style="padding-right:10px;">${button({ href: links.reject, label: 'Reject', color: COLORS.negative })}</td><td>${button({ href: links.view, label: 'View in app', color: COLORS.brand })}</td></tr></table>`
    : `<p style="margin-top:20px;">${button({ href: links.view, label: 'Open in app' })}</p>`

  const html = layout({
    title: reminder ? 'Reminder: your approval is pending' : 'Your approval is required',
    preheader: `${doc} - ${amount} - compliance ${outcomeText}`,
    body: table(rows) + issueList + justification + buttons +
      `<p style="margin:16px 0 0 0;${FONT};font-size:12px;color:#556b82;">You will be asked to sign in and confirm your decision. Nothing is approved just by opening a link.</p>`
  })
  const text = [
    reminder ? 'REMINDER - approval pending' : 'Approval required',
    `Request: ${pr.prNumber} - ${pr.title}`,
    task.kind === 'VARIANCE' ? `Purchase Order: ${po?.poNumber}` : null,
    `Amount: ${amount}`, `Requester: ${pr.requesterName ?? '-'}`, `Vendor: ${pr.vendorName ?? '-'}`,
    `Step: Level ${task.level} - ${task.levelName ?? ''}`, `Due: ${fmtDate(task.dueAt)}`, `Compliance: ${outcomeText}`,
    ...issues.map(c => `  ${c.checkType} (${c.result}): ${c.message}`),
    '', links.approve ? `Approve: ${links.approve}` : null, links.reject ? `Reject: ${links.reject}` : null, `View: ${links.view}`
  ].filter(l => l !== null).join('\n')
  return { subject, html, text }
}

const STATUS_TONE = { Approved: 'positive', Rejected: 'negative', Blocked: 'negative', Withdrawn: 'neutral', APPROVED: 'positive', REJECTED: 'negative', Posted: 'positive', Failed: 'negative' }

function commentsBlock(comments = []) {
  if (!comments.length) return ['', []]
  const html = `<p style="margin:16px 0 6px 0;${FONT};font-size:13px;color:#556b82;"><b>Comments</b></p>` +
    comments.map(c => `<p style="margin:0 0 6px 0;${FONT};font-size:13px;color:#1d2d3e;"><b>${esc(c.approverName ?? c.approver_userId)}</b> (${esc(c.status)}): ${esc(c.comment)}</p>`).join('')
  return [html, ['Comments:', ...comments.map(c => `  ${c.approverName ?? c.approver_userId} (${c.status}): ${c.comment}`)]]
}

/** @param {object} d { pr, comments[], link } */
export function prDecisionMail({ pr, comments, link }) {
  const amount = fmtAmount(pr.totalAmount, pr.currency_code)
  const subject = `${pr.prNumber}: ${pr.status} - ${pr.title}`.slice(0, 200)
  const [cHtml, cText] = commentsBlock(comments)
  const next = pr.status === 'Approved' ? 'You can now create the Purchase Order from the request.' :
    pr.status === 'Blocked' ? 'Please review the compliance findings, correct the request and resubmit.' :
    pr.status === 'Rejected' ? 'You may revise the request and resubmit it.' : ''
  const html = layout({
    title: `Purchase Requisition ${pr.status}`,
    preheader: `${pr.prNumber} - ${amount}`,
    body: table([row('Request', `<b>${esc(pr.prNumber)}</b> &ndash; ${esc(pr.title)}`), row('Amount', esc(amount)), row('Status', badge(pr.status, STATUS_TONE[pr.status]))]) +
      cHtml + (next ? `<p style="margin:16px 0;${FONT};font-size:14px;color:#1d2d3e;">${esc(next)}</p>` : '') +
      `<p style="margin-top:20px;">${button({ href: link, label: 'Open request' })}</p>`
  })
  const text = [`${pr.prNumber} - ${pr.title}`, `Status: ${pr.status}`, `Amount: ${amount}`, ...cText, next, `Open: ${link}`].filter(Boolean).join('\n')
  return { subject, html, text }
}

/** @param {object} d { kind: 'variance'|'posted'|'failed', po, comments[], link } */
export function poMail({ kind, po, comments, link }) {
  const amount = fmtAmount(po.totalAmount, po.currency_code)
  const variants = {
    variance: [`PO ${po.poNumber}: variance ${po.varianceApproval === 'APPROVED' ? 'approved' : 'rejected'}`, `Variance ${po.varianceApproval === 'APPROVED' ? 'approved' : 'rejected'}`, po.varianceApproval,
      po.varianceApproval === 'APPROVED' ? 'The Purchase Order can now be posted to S/4HANA.' : 'Please adjust the Purchase Order to match the approved requisition.'],
    posted: [`PO ${po.poNumber} posted to S/4HANA as ${po.s4PONumber}`, 'Purchase Order posted to S/4HANA', 'Posted', `S/4HANA purchase order number: ${po.s4PONumber}`],
    failed: [`PO ${po.poNumber}: posting to S/4HANA failed`, 'Posting to S/4HANA failed', 'Failed', `Error: ${po.s4Error ?? 'unknown'} - please correct and retry.`]
  }
  const [subject, title, status, note] = variants[kind]
  const [cHtml, cText] = commentsBlock(comments)
  const html = layout({
    title, preheader: `${po.poNumber} - ${amount}`,
    body: table([row('Purchase Order', `<b>${esc(po.poNumber)}</b>`), row('Requisition', esc(po.prNumber)), row('Amount', esc(amount)), row('Status', badge(status, STATUS_TONE[status]))]) +
      cHtml + `<p style="margin:16px 0;${FONT};font-size:14px;color:#1d2d3e;">${esc(note)}</p>` +
      `<p style="margin-top:20px;">${button({ href: link, label: 'Open Purchase Order' })}</p>`
  })
  const text = [subject, `Requisition: ${po.prNumber ?? '-'}`, `Amount: ${amount}`, ...cText, note, `Open: ${link}`].join('\n')
  return { subject: subject.slice(0, 200), html, text }
}

// ---------------------------------------------------------------------------
// Confirmation / result pages for /email-action (CSP: styles only via nonce)
// ---------------------------------------------------------------------------
export function page({ title, tone = 'neutral', body, nonce }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} - PR Compliance</title>
<style nonce="${esc(nonce)}">
body{margin:0;background:#f5f6f7;font-family:'72','Segoe UI',Arial,sans-serif;color:#1d2d3e}
header{background:#354a5f;color:#fff;padding:12px 24px;font-weight:bold;font-size:15px}
main{max-width:560px;margin:32px auto;padding:0 16px}
.card{background:#fff;border:1px solid #d9d9d9;border-radius:12px;padding:24px;box-shadow:0 0 2px rgba(34,53,72,.2),0 2px 4px rgba(34,53,72,.2)}
h1{font-size:20px;margin:0 0 16px}
.tone{border-left:4px solid ${COLORS[tone] ?? COLORS.neutral};padding-left:12px}
dl{display:grid;grid-template-columns:140px 1fr;gap:8px 12px;margin:0 0 16px}
dt{color:#556b82;font-size:13px}dd{margin:0;font-size:14px}
label{display:block;font-size:13px;color:#556b82;margin:12px 0 6px}
textarea{width:100%;box-sizing:border-box;min-height:84px;border:1px solid #8396a8;border-radius:8px;padding:8px;font:inherit}
.err{color:${COLORS.negative};font-size:13px;margin:8px 0}
.actions{margin-top:20px;display:flex;gap:10px}
button,.btn{border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:bold;cursor:pointer;text-decoration:none;display:inline-block}
.approve{background:${COLORS.positive};color:#fff}.reject{background:${COLORS.negative};color:#fff}.ghost{background:#fff;color:${COLORS.brand};border:1px solid ${COLORS.brand}}
p{line-height:1.5}
</style></head><body><header>PR Compliance</header><main><div class="card"><div class="tone"><h1>${esc(title)}</h1></div>${body}</div></main></body></html>`
}

export function confirmPage({ nonce, action, token, formToken, ctx, error, comment = '' }) {
  const { task, pr, po } = ctx
  const approve = action === 'approve'
  const body = `<dl>
<dt>Request</dt><dd><b>${esc(pr.prNumber)}</b> &ndash; ${esc(pr.title)}</dd>
${po ? `<dt>Purchase Order</dt><dd>${esc(po.poNumber)}</dd>` : ''}
<dt>Amount</dt><dd><b>${esc(fmtAmount(po?.totalAmount ?? pr.totalAmount, po?.currency_code ?? pr.currency_code))}</b></dd>
<dt>Requester</dt><dd>${esc(pr.requesterName)}</dd>
<dt>Vendor</dt><dd>${esc(pr.vendorName)}</dd>
<dt>Approval step</dt><dd>Level ${esc(task.level)} &ndash; ${esc(task.levelName)}</dd>
<dt>Compliance</dt><dd>${esc((OUTCOME[pr.complianceOutcome] ?? ['Not checked'])[0])}</dd>
</dl>
<form method="post" action="email-action">
<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="f" value="${esc(formToken)}">
<label for="comment">Comment${approve ? ' (optional)' : ' (required)'}</label>
<textarea id="comment" name="comment" maxlength="500"${approve ? '' : ' required'}>${esc(comment)}</textarea>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<div class="actions"><button type="submit" class="${approve ? 'approve' : 'reject'}">${approve ? 'Confirm approval' : 'Confirm rejection'}</button></div>
</form>`
  return page({ title: approve ? 'Approve this request?' : 'Reject this request?', tone: approve ? 'positive' : 'negative', body, nonce })
}

export function resultPage({ nonce, title, message, tone = 'neutral', link }) {
  return page({
    title, tone, nonce,
    body: `<p>${esc(message)}</p>${link ? `<div class="actions"><a class="btn ghost" href="${esc(link)}">Open in app</a></div>` : ''}`
  })
}
