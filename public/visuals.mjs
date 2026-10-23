const paths = {
  chat: "M5 5h14v11H9l-4 4V5Z",
  work: "m9 5 10 7-10 7V5Z",
  memory: "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5",
  connections: "M9 8V5a3 3 0 0 1 6 0v3 M9 16v3a3 3 0 0 0 6 0v-3 M5 9h14v6H5z",
  plus: "M12 5v14 M5 12h14",
  send: "M12 19V5 m-6 6 6-6 6 6",
  pause: "M9 5v14 M15 5v14",
  check: "m5 12 4 4L19 6",
  mark: "M5 13V9 M9 16V6 M13 14V8 M13 14l3 3 5-6",
};
let beeMarkInstance = 0;
export const beeMark = (cls = "") => {
  const id = `bee-${beeMarkInstance++}`;
  return `<svg class="ui-icon bee-mark ${cls}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><defs><radialGradient id="${id}-body" cx=".28" cy=".12" r="1.05"><stop stop-color="#ffe795"/><stop offset=".45" stop-color="#f5c343"/><stop offset="1" stop-color="#d99a22"/></radialGradient><radialGradient id="${id}-wing" cx=".25" cy=".15" r="1"><stop stop-color="#fff9dc"/><stop offset=".55" stop-color="#f5dc8c"/><stop offset="1" stop-color="#d6b352"/></radialGradient><linearGradient id="${id}-stripe" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#535044"/><stop offset=".45" stop-color="#302f28"/><stop offset="1" stop-color="#1e201c"/></linearGradient></defs><g transform="rotate(-18 16 17)"><path d="M13 13C4 10 6 2 11 4c3 1 5 5 5 8 1-8 7-10 9-6 2 4-3 7-7 9Z" fill="url(#${id}-wing)"/><path d="M9 5c2 0 4 3 5 6M21 5c-2 1-3 4-3 6" stroke="#fffbe4" stroke-width=".8" stroke-linecap="round" opacity=".65"/><path d="m4 20-4 3 5 1" fill="#302f28"/><path d="M13 11h7c7 0 11 4 11 9s-4 9-11 9h-7C6 29 2 25 2 20s4-9 11-9Z" fill="url(#${id}-body)"/><path d="M8.8 11.7c1.5 4 2 12.3.5 16.5l2.7.6c1.7-5.8 1.1-13.5-.6-17.7ZM13.9 11c2.1 5 2.1 13 .9 18h2.7c1.1-5.3 1-13.2-1.1-18Z" fill="url(#${id}-stripe)"/><path d="M5.5 17c1.4-2.5 3.5-4 6.5-4.5M18 12.5c3-.2 5.6.5 7.6 1.7" stroke="#fff4c6" stroke-width="1" stroke-linecap="round" opacity=".55"/><rect x="21" y="15.5" width="2.7" height="6" rx="1.35" fill="#272923"/><rect x="26" y="15.5" width="2.7" height="6" rx="1.35" fill="#272923"/><path d="M21.7 16.4v1M26.7 16.4v1" stroke="#fff9df" stroke-width=".45" stroke-linecap="round" opacity=".3"/></g></svg>`;
};
export const icon = (name, cls = "") => name === "mark" ? beeMark(cls) :
  `<svg class="ui-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] ?? paths.mark}"/></svg>`;

/** Presentation preferences only: hiding never mutates stored tasks or authority. */
export function taskNavigation(conversations, hiddenIds = []) {
  const hidden = new Set(hiddenIds);
  const examples = (c) => c.mode === "fixture" || c.source?.type === "synthetic-evaluation" || c.source?.simulated === true;
  return {
    current: conversations.filter((c) => !hidden.has(c.id) && !c.presentationArchived && !examples(c)),
    examples: conversations.filter((c) => !hidden.has(c.id) && examples(c)),
    hidden: conversations.filter((c) => hidden.has(c.id) || c.presentationArchived),
  };
}
export function taskTitle(c) {
  const current = c.steps?.find((s) => s.receipt?.artifactId)?.title;
  return (current || c.messages?.find((m) => m.role === "user")?.text || "Untitled task").replace(/\s+/g, " ").slice(0, 70);
}
export function currentOutputCount(c) {
  const current = new Set(c.steps.filter((step) => step.status === "completed").map((step) => step.receipt?.artifactId).filter(Boolean));
  return c.artifacts.filter((artifact) => current.has(artifact.id)).length;
}
/** UI mirrors the server's scoped stream prerequisite; it never grants Follow. */
export function beeStreamControls(state, { now = Date.now(), pending = false } = {}) {
  const eligible = (state.follows ?? []).some((follow) => {
    const source = (state.sources ?? []).find((s) => s.id === follow.source);
    return follow.expiresAt > now && !follow.pausedReason && source &&
      !source.deleted && !source.simulated && source.conversationId && source.conversationUuid;
  });
  const requested = state.worker?.supervision?.desiredStream === true || state.bee?.started === true;
  return {
    canStart: Boolean(eligible && !requested && !pending),
    canStop: Boolean(requested && !pending),
    help: eligible
      ? "Live updates read only conversations you chose to Follow. Missed events are recovered by selected-source refresh."
      : "In From Bee, choose a conversation, open Follow and source details, select Follow, then Start task and confirm the displayed scope. Watching for new conversations does not enable Follow.",
  };
}
export function beeStreamError(message) {
  return message === "SelectAndFollowMappedBeeConversationFirst"
    ? "Live updates need a selected Bee conversation with active Follow. Open From Bee and confirm Follow for that conversation. If Follow expired, stopped or paused, review its scope again. Watching for new conversations alone is not enough."
    : message;
}
export function draftContent(text, escape) {
  if (/(^#{1,6}\s|^\s*[-*]\s|^\s*\d+[.)]\s|\*\*|^\s*```)/m.test(text))
    return renderDraftMarkdown(text, escape);
  const lines = text.split("\n");
  const agenda = lines.map((line) => line.match(/^(\d+[–-]\d+):\s*(.+)$/));
  if (agenda.filter(Boolean).length >= 2)
    return (
      '<div class="agenda">' +
      lines
        .map((line, i) =>
          agenda[i]
            ? '<div class="agenda-row"><span>' +
              escape(agenda[i][1]) +
              "</span><p>" +
              escape(agenda[i][2]) +
              "</p></div>"
            : '<p class="draft-intro">' + escape(line) + "</p>",
        )
        .join("") +
      "</div>"
    );
  if (lines.filter((line) => /^(Before|During|After):/.test(line)).length >= 2)
    return (
      '<div class="checklist">' +
      lines
        .map((line) => {
          const m = line.match(/^(Before|During|After):\s*(.+)$/);
          return m
            ? '<div class="checklist-row"><span class="list-point"></span><div><b>' +
                escape(m[1]) +
                "</b><p>" +
                escape(m[2]) +
                "</p></div></div>"
            : '<p class="draft-note">' + escape(line) + "</p>";
        })
        .join("") +
      "</div>"
    );
  return renderDraftMarkdown(text, escape);
}

export function renderPrivateArtifact(a, escape, { readOnly = false } = {}) {
  const v = a.verification;
  const notice = a.provisional
    ? '<p class="subtle">Provisional private preparation. A material question is still open; review before use.</p>'
    : "";
  if (v.kind === "document") return notice + draftContent(a.content, escape);
  if (v.kind === "schedule")
    return (
      '<div class="draft-agenda">' +
      v.data.blocks
        .map(
          (b) =>
            '<div class="agenda-row"><time>' +
            escape(b.start) +
            "–" +
            escape(b.end) +
            "</time><span>" +
            escape(b.title) +
            "</span><small>" +
            b.minutes +
            " min</small></div>",
        )
        .join("") +
      "</div>" +
      (v.data.unscheduled.length
        ? "<p>Unscheduled: " + escape(v.data.unscheduled.join("; ")) + "</p>"
        : "") +
      '<p class="subtle">Private time plan · calendar unchanged</p>'
    );
  if (v.kind === "checklist")
    return (
      notice +
      '<div class="durable-checklist">' +
      v.data.items
        .map(
          (item) =>
            '<label><input type="checkbox" ' +
            (readOnly
              ? "disabled "
              : 'data-checklist-artifact="' +
                escape(a.id) +
                '" data-checklist-item="' +
                escape(item.id) +
                '" ') +
            (a.progress?.[item.id]?.done ? "checked" : "") +
            "><span>" +
            escape(item.text) +
            "</span></label>",
        )
        .join("") +
      '</div><p class="sr-only">Checkboxes record your progress, not automatic completion.</p>'
    );
  return "";
}

/** Receipts identify a rendered revision; step IDs may be reused by corrections. */
export function renderArtifactHistory(conversation, escape) {
  const displayed = new Set(
    conversation.steps
      .filter((step) => step.status === "completed")
      .map((step) => step.receipt?.artifactId)
      .filter(Boolean),
  );
  const previous = conversation.artifacts
    .filter((artifact) => !displayed.has(artifact.id))
    .map(
      (artifact) =>
        `<section class="draft-artifact" data-artifact-history="${escape(artifact.id)}"><h4>${escape(artifact.title)}</h4><details><summary>Earlier revision ${escape(String(artifact.plan?.revision ?? "unknown"))} · saved history</summary><p class="subtle">Historical result. Owner progress belongs to this revision only.</p>${artifact.verification ? renderPrivateArtifact(artifact, escape, { readOnly: true }) : '<p class="message-text">' + escape(artifact.content) + "</p>"}</details></section>`,
    )
    .join("");
  const count = conversation.artifacts.filter((artifact) => !displayed.has(artifact.id)).length;
  return count ? `<details class="artifact-history"><summary>Earlier versions · ${count}</summary>${previous}</details>` : "";
}

/** Tab-local drafts are isolated by conversation; New task has its own slot. */
export function createComposerDrafts({ read, write, storage }) {
  const storageKey = "bee.composer-drafts.v1";
  let drafts = new Map(),
    active = null,
    restoredId;
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (saved && Array.isArray(saved.entries)) {
      drafts = new Map(
        saved.entries.filter(
          (x) =>
            Array.isArray(x) &&
            x.length === 2 &&
            typeof x[0] === "string" &&
            typeof x[1] === "string",
        ),
      );
      restoredId =
        typeof saved.conversationId === "string" ? saved.conversationId : null;
    }
  } catch {
    /* Unavailable storage cannot mix drafts; retain this session in memory. */
  }
  const key = (id) => (id ? "conversation:" + id : "new-task");
  const persist = () => {
    try {
      storage?.setItem(
        storageKey,
        JSON.stringify({
          conversationId: active?.startsWith("conversation:")
            ? active.slice(13)
            : null,
          entries: [...drafts],
        }),
      );
    } catch {
      /* Keep in-memory drafts if tab storage is full or disabled. */
    }
  };
  const save = () => {
    if (active !== null) {
      drafts.set(active, read());
      persist();
    }
  };
  return {
    currentId: () => restoredId,
    save,
    select(id) {
      const next = key(id);
      if (active === next) return;
      save();
      active = next;
      restoredId = id ?? null;
      write(drafts.get(next) ?? "");
      persist();
    },
    acknowledge(id, submittedText) {
      const target = key(id);
      if (active === target) {
        if (read() !== submittedText) return;
        write("");
      } else if (drafts.get(target) !== submittedText) return;
      drafts.delete(target);
      persist();
    },
    clear() {
      if (active !== null) {
        drafts.delete(active);
        write("");
        persist();
      }
    },
  };
}

export function memoryExpiryResult(
  value,
  { initialValue, currentExpiry, now = Date.now },
) {
  const expiresAt =
    value === initialValue
      ? (currentExpiry ?? null)
      : value
        ? new Date(value).getTime()
        : null;
  return expiresAt !== null &&
    (!Number.isFinite(expiresAt) || expiresAt <= now())
    ? { expiresAt, error: "Choose a future date and time, or clear expiry." }
    : { expiresAt, error: null };
}
/** Feedback belongs to this editor, never the page's unrelated task alert. */
export function createMemoryFeedback({ expiry, expiryError, formError }) {
  const clear = () => {
    for (const element of [expiryError, formError]) {
      element.textContent = "";
      element.hidden = true;
    }
    expiry.removeAttribute("aria-invalid");
  };
  return {
    clear,
    show(message) {
      clear();
      const isExpiry = String(message).startsWith("InvalidMemoryExpiry:");
      const target = isExpiry ? expiryError : formError;
      target.textContent = isExpiry
        ? "Choose a future date and time, or clear expiry."
        : "Changes were not saved. " + String(message).slice(0, 500);
      target.hidden = false;
      if (isExpiry) expiry.setAttribute("aria-invalid", "true");
    },
  };
}

export function conversationAnnouncement(status) {
  return (
    {
      thinking: "Companion is preparing a proposal.",
      clarifying: "Companion needs your clarification.",
      plan_review: "A plan is ready for your approval.",
      acting: "Approved local test is running.",
      review_required: "Results are ready for your review.",
      paused: "Conversation paused. Prior plans revoked.",
      pausing: "Pause requested. Waiting for interruption.",
      cancelling:
        "Cancellation requested. Waiting for interruption; unused plans revoked.",
      cancelled: "Conversation cancelled.",
      completed: "Results accepted.",
    }[status] ?? "Conversation updated."
  );
}

/** A local checkbox is a draft preference, never persisted Follow authority. */
export function resetInboxFollowChoice(drafts, sourceId, article = null) {
  const draft = drafts.get(sourceId);
  if (draft) drafts.set(sourceId, { ...draft, follow: false });
  const checkbox = article?.querySelector("[data-follow-source]");
  if (checkbox) checkbox.checked = false;
}

export function resetRemovedInboxFollowChoices(
  drafts,
  previousArticles,
  sources,
) {
  const visible = new Set(sources.map((source) => source.id));
  for (const [id, article] of previousArticles)
    if (!visible.has(id)) resetInboxFollowChoice(drafts, id, article);
}

/** Small escaped-text subset; no HTML, links, media or executable markup. */
export function renderDraftMarkdown(text, escape) {
  const inline = (value) =>
    escape(value).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  const output = [];
  let paragraph = [],
    list = null,
    code = null;
  const flush = () => {
    if (paragraph.length) {
      output.push("<p>" + paragraph.map(inline).join("<br>") + "</p>");
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      output.push("</" + list + ">");
      list = null;
    }
  };
  const lines = text.split(/\r?\n/);
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const separator = (line) => line?.includes("|") && cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush();
      closeList();
      if (code) {
        output.push("<pre><code>" + escape(code.join("\n")) + "</code></pre>");
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (line.includes("|") && separator(lines[index + 1])) {
      const headers = cells(line);
      if (headers.length === cells(lines[index + 1]).length) {
        flush();
        closeList();
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes("|") && cells(lines[index]).length === headers.length) {
          rows.push(cells(lines[index]));
          index++;
        }
        index--;
        const timed = /^(?:time|when)$/i.test(headers[0]) && rows.every((row) => row[0].length <= 25 && /^[\d:\s–—−-]+(?:min(?:utes?)?)?$/i.test(row[0]));
        output.push('<table' + (timed ? ' data-time-table' : '') + '><thead><tr>' + headers.map((cell) => '<th scope="col">' + inline(cell) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + inline(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
    }
    if (!line.trim()) {
      flush();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      closeList();
      const level = Math.min(6, heading[1].length + 2);
      output.push(
        "<h" + level + ">" + inline(heading[2]) + "</h" + level + ">",
      );
      continue;
    }
    const item = /^\s*(?:([-*])\s+|\d+[.)]\s+)(.*)$/.exec(line);
    if (item) {
      flush();
      const kind = item[1] ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        output.push("<" + kind + ">");
        list = kind;
      }
      output.push(
        "<li>" + inline(item[2].replace(/^\[[ xX]\]\s+/, "")) + "</li>",
      );
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flush();
  closeList();
  if (code)
    output.push("<pre><code>" + escape(code.join("\n")) + "</code></pre>");
  return '<div class="markdown-draft">' + output.join("") + "</div>";
}

export function beeSourceStatus(status) {
  return ({COMPLETED:'Ready',PROCESSING:'Processing',RECORDING:'Recording'})[status] ?? 'Processing state unavailable';
}
/** Decode readable fields from a growing JSON response, never execute or trust it. */
export function proposalStreamSections(raw) {
  const sections=[];
  function stringAt(start){
    let end=start+1,escaped=false;
    for(;end<raw.length;end++){
      if(!escaped && raw[end]==='"')break;
      if(!escaped && raw[end]==='\\')escaped=true;else escaped=false;
    }
    const closed=end<raw.length;
    let fragment=raw.slice(start+1,end),value='';
    for(let trim=0;trim<=Math.min(6,fragment.length);trim++){
      try{value=JSON.parse('"'+fragment.slice(0,fragment.length-trim)+'"');break;}catch{}
    }
    return {value:value.replace(/[\uD800-\uDBFF]$/,''),end:closed?end+1:end,closed};
  }
  const stack=[];
  const takePath=()=>{const parent=stack.at(-1);if(!parent)return [];const path=parent.path.concat(parent.type==='array'?parent.index++:parent.key);parent.key=null;return path;};
  for(let i=0;i<raw.length;i++){
    const char=raw[i];
    if(char==='{' || char==='['){stack.push({type:char==='{'?'object':'array',path:takePath(),index:0,key:null});continue;}
    if(char==='}' || char===']'){stack.pop();continue;}
    if(char==='"'){
      const token=stringAt(i);i=token.end-1;
      let next=token.end;while(next<raw.length && /\s/.test(raw[next]))next++;
      if(token.closed && raw[next]===':' && stack.at(-1)?.type==='object'){
        stack.at(-1).key=token.value;i=next;continue;
      }
      const path=takePath();
      const readable=path.length===1 && path[0]==='reply' || path.length===3 && path[0]==='steps' && typeof path[1]==='number' && path[2]==='content';
      if(!readable || !token.value)continue;
      if(path[0]==='steps' && /^[\s]*[\[{]/.test(token.value)){
        if(token.closed)try{const content=JSON.parse(token.value);if(Array.isArray(content.items))sections.push(content.items.filter(x=>typeof x.text==='string').map(x=>'- '+x.text).join('\n'));}catch{}
      }else sections.push(token.value);
    }else if(!/[\s,:]/.test(char)){
      takePath();while(i+1<raw.length && !/[\s,}\]]/.test(raw[i+1]))i++;
    }
  }
  return sections.filter(Boolean);
}
export function renderLiveProposal(conversation,escape){
  if(conversation.status!=='thinking' || conversation.sourceRevoked || !conversation.stream)return '';
  const sections=proposalStreamSections(conversation.stream);
  return sections.length?'<section class="draft-artifact live-response" aria-label="Live draft"><p class="subtle">Writing draft · not finished</p>'+draftContent(sections.join('\n\n'),escape)+'</section>':'';
}

/** Coalesce SSE/poll requests without overlapping snapshots or stale rollback. */
export function createCoalescedRefresh(run){
  let pending=null,again=false;
  return function refresh(){
    if(pending){again=true;return pending;}
    pending=(async()=>{do{again=false;await run();}while(again);})().finally(()=>{pending=null;});
    return pending;
  };
}

export function shouldSubmitComposer(event){
  return event.key==='Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && event.keyCode!==229;
}
