import {
  icon,
  taskNavigation,
  taskTitle,
  currentOutputCount,
  draftContent,
  renderPrivateArtifact as artifactBody,
  renderArtifactHistory,
  createComposerDrafts,
  memoryExpiryResult,
  createMemoryFeedback,
  conversationAnnouncement,
  resetInboxFollowChoice,
  resetRemovedInboxFollowChoices,
  beeStreamControls,
  beeStreamError,
  beeSourceStatus,
  renderLiveProposal,
  createCoalescedRefresh,
  shouldSubmitComposer,
} from "./visuals.mjs";
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
const $ = (s) => document.querySelector(s);
const developerMode = new URLSearchParams(location.search).get("developer") === "1";
if (developerMode) document.querySelectorAll("[data-development-only]").forEach((element) => { element.hidden = false; element.inert = false; });
let state = { tasks: [], memories: [], captures: [], provider: {}, bee: {} },
  selected = null,
  page = "companion",
  detailKey = "",
  memoryKey = "";
let conversationId = null,
  conversationKey = "",
  recentKey = "",
  memoryOptionsKey = "",
  sidebarTaskKey = "",
  announcementKey = "";
let inboxKey = "",
  taskListKey = "",
  ownershipKey = "",
  capturesKey = "";
const inboxDrafts = new Map();
let streamPending = false;
let selectedBeeSource = sessionStorage.getItem("beebot.selected-source.v1");
let showArchivedBeeSources = false;
let restoredArchivedTasks=[];
try { restoredArchivedTasks=JSON.parse(localStorage.getItem("beebot.restored-tasks.v1")??"[]"); } catch {}
const visibleConversations=()=> (state.conversations??[]).map(c=>restoredArchivedTasks.includes(c.id)?{...c,presentationArchived:false}:c);

let initialConversationLoad = true;
let hiddenConversations = [];
try { const saved = JSON.parse(localStorage.getItem("beebot.hidden-tasks.v1") ?? "[]"); if (Array.isArray(saved)) hiddenConversations = saved.filter((id) => typeof id === "string"); } catch {}
function persistHiddenConversations() {
  try { localStorage.setItem("beebot.hidden-tasks.v1", JSON.stringify(hiddenConversations)); } catch {}
}

const memoryFeedbacks = new Set();
const clearMemoryFeedbacks = () =>
  memoryFeedbacks.forEach((feedback) => feedback.clear());
let draftStorage;
try {
  draftStorage = window.sessionStorage;
} catch {
  /* Use in-memory drafts. */
}
const composerDrafts = createComposerDrafts({
  storage: draftStorage,
  read: () => $("#conversation-input").value,
  write: (value) => {
    $("#conversation-input").value = value;
    $("#conversation-input").placeholder = "Message BeeBot…";
    resizeComposer();
  },
});
conversationId = composerDrafts.currentId();
function resizeComposer() {
  const input = $("#conversation-input");
  input.style.height = "auto";
  input.style.height = Math.min(160, Math.max(48, input.scrollHeight)) + "px";
}
$("#conversation-input").addEventListener("input", () => { composerDrafts.save(); resizeComposer(); });
$("#conversation-input").addEventListener("keydown", (event) => {
  if(shouldSubmitComposer(event)) { event.preventDefault(); $("#conversation-form").requestSubmit(); }
});
const contextOptions = $(".composer-options");
document.addEventListener("click", (event) => { if (contextOptions.open && !event.target.closest(".composer-options")) contextOptions.open = false; });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && contextOptions.open) { contextOptions.open = false; contextOptions.querySelector("summary").focus(); event.preventDefault(); } });
window.addEventListener("pagehide", () => { composerDrafts.save(); });
let lastInput = "keyboard";
document.addEventListener(
  "pointerdown",
  () => {
    lastInput = "pointer";
    document.body.classList.add("pointer-input");
  },
  { passive: true },
);
document.addEventListener("keydown", () => {
  lastInput = "keyboard";
  document.body.classList.remove("pointer-input");
});
let busy = false;
let online = true;
let composing = conversationId === null;
const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const titles = {
  interpretation_queued: "Queued for interpretation",
  interpreting: "Interpreting your request",
  clarifying: "Let’s confirm what you mean.",
  acceptance_approval: "Your next decision",
  queued: "Queued for this Mac",
  testing: "Running the acceptance test",
  patch_approval: "A small fix, ready for approval",
  applying: "Applying the approved patch",
  retesting: "Checking the proposed fix",
  review_required: "Ready for your review",
  completed: "You accepted this work",
  paused: "Work is paused",
  pausing: "Waiting for the worker to pause",
  cancelling: "Cancellation requested",
  cancelled: "Work cancelled",
  failed: "This attempt needs attention",
  reconciliation_required: "Check the interrupted attempt",
};
let errorScope = "action";
function error(message, scope = "action") {
  message = beeStreamError(message);
  errorScope = scope;
  $("#error").textContent = message;
  $("#error").hidden = !message;
}
async function api(path, data) {
  const r = await fetch("/api/" + path, {
    method: data ? "POST" : "GET",
    headers: data
      ? { "content-type": "application/json", "x-bee-csrf": state.csrf }
      : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await r.json();
  if (!r.ok) {
    const failure = Error(body.error ?? "Request failed");
    failure.existingConversationId = body.existingConversationId;
    throw failure;
  }
  return body;
}
const refresh = createCoalescedRefresh(refreshOnce);
async function refreshOnce() {
  try {
    const next = await api("snapshot");
    state = next;
    online = true;
    if (errorScope === "transport") error("");
    $("#connection").textContent = "Connected to this Mac";
    $("#count").textContent = taskNavigation(visibleConversations()).current.filter((c) => ["clarifying","plan_review","review_required","source_changed"].includes(c.status)).length || "";
    $("#task-total").textContent = state.tasks.length;
    if (!selected && !composing && state.tasks.length)
      selected = state.tasks[0].id;
    renderList();
    renderOwnership();
    renderDetail();
    if (page === "memory") renderMemory();
    renderConnections();
    const taskListKey = JSON.stringify(state.tasks.map((t) => [t.id, t.text]));
    if (taskListKey !== sidebarTaskKey) {
      sidebarTaskKey = taskListKey;
      $("#sidebar-tasks").innerHTML = state.tasks
        .slice(0, 5)
        .map(
          (t) =>
            '<button data-recent-task="' +
            escape(t.id) +
            '">' +
            escape(t.text.slice(0, 40)) +
            "</button>",
        )
        .join("");
      document.querySelectorAll("[data-recent-task]").forEach(
        (b) =>
          (b.onclick = () => {
            selected = b.dataset.recentTask;
            detailKey = "";
            navigate("work");
            renderDetail();
          }),
      );
    }
    renderConversations();
    if (page === "inbox") renderInbox();
  } catch (e) {
    online = false;
    $("#connection").textContent =
      "Worker unavailable. Requests are not acknowledged or queued.";
    error("Worker unavailable. Your draft is kept. Reconnect and check the task before resending.", "transport");
  }
}
function renderList() {
  $("#new-request").hidden = Boolean(selected);
  $(".intro").hidden = Boolean(selected);
  if (page === "work") $("#page-title").textContent = "Tasks";
  const key = JSON.stringify([
    selected,
    state.tasks.map((t) => [t.id, t.text, t.proposal?.summary, t.status]),
  ]);
  if (key === taskListKey) return;
  taskListKey = key;
  $("#tasks").innerHTML = state.tasks.length
    ? state.tasks
        .map(
          (t) =>
            `<button class="${t.id === selected ? "selected" : ""}" data-task="${escape(t.id)}"><strong>${escape(t.proposal?.summary ?? t.text).slice(0, 110)}</strong><small>${escape(titles[t.status] ?? t.status)}</small></button>`,
        )
        .join("")
    : '<p class="subtle">Your requests will appear here.</p>';
  $("#tasks")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          selected = b.dataset.task;
          composing = false;
          detailKey = "";
          renderDetail();
          renderList();
        }),
    );
}
function task() {
  return state.tasks.find((t) => t.id === selected);
}
async function command(type, extra = {}) {
  const t = task();
  if (!t) return;
  await act(async () => {
    const result = await api("command", {
      taskId: t.id,
      command: { id: crypto.randomUUID(), version: t.version, type, ...extra },
    });
    selected = result.id;
    detailKey = "";
    await refresh();
  });
}
async function act(fn) {
  if (busy) return;
  busy = true;
  error("");
  try {
    await fn();
  } catch (e) {
    error(e.message);
  } finally {
    busy = false;
  }
}
function renderDetail() {
  const t = task();
  if (!t) return;
  const key = t.id + ":" + t.version;
  if (key === detailKey) return;
  detailKey = key;
  const provenance = t.simulated
    ? "Simulated Bee input · authored fixture"
    : t.recovered
      ? "Recovered Bee excerpt · selected anew"
      : t.source === "typed"
        ? "Typed request"
        : "Selected Bee stream excerpt";
  let content = "";
  if (t.proposal)
    content += `<div class="summary"><p>${escape(t.proposal.summary)}</p><p class="subtle">Interpreted by ${escape(t.proposal.model)} via your ChatGPT plan. Proposal only.</p>${t.proposal.questions?.length ? "<ul>" + t.proposal.questions.map((q) => "<li>" + escape(q) + "</li>").join("") + "</ul>" : ""}</div>`;
  if (t.status === "clarifying" && t.workflow !== "reminder-policy")
    content +=
      '<section class="card"><h4>This needs a different action workflow.</h4><p class="summary">I can keep the request and its proposal here. The current executable adapter handles reminder due-time tests only; I will not substitute that demo for your request.</p><p class="subtle">Use Change this request below to clarify or choose the reminder demo explicitly.</p></section>';
  if (t.status === "clarifying" && t.workflow === "reminder-policy")
    content += `<section class="card"><h4>Confirm the acceptance conditions</h4><p class="summary">The first executable workflow checks reminder due times in an isolated demo. Other requests can be interpreted, but do not have action adapters yet.</p><label class="check"><input id="inclusive" type="checkbox" ${(t.proposal?.inclusive ?? true) ? "checked" : ""}> Include a reminder due exactly now</label><label class="check"><input id="exclude" type="checkbox" ${(t.proposal?.excludeCompleted ?? true) ? "checked" : ""}> Completed reminders are never due</label><button id="confirm-cases" class="primary">Prepare acceptance test</button><p class="subtle">${t.proposal ? "Review the proposed conditions before continuing." : "Local template interpreter · no model used."}</p></section>`;
  if (["acceptance_approval", "patch_approval"].includes(t.status) && t.plan) {
    content += `<section class="card"><h4>${t.status === "patch_approval" ? "Apply one file change, then retest?" : "Run these acceptance cases?"}</h4><div class="cases">${t.plan.cases.map((c) => `<div class="case"><span>${escape(c.name)}</span><b>${c.expected ? "Due" : "Not due"}</b></div>`).join("")}</div>${t.plan.kind === "patch" ? `<details open><summary>Proposed reminders.mjs</summary><pre>${escape("- " + t.plan.beforeSource + "+ " + t.plan.content)}</pre><p class="subtle">Replaces the baseline strict comparison with the confirmed rule. No other file is changed.</p></details>` : ""}<div class="scope">${escape(t.plan.target)} · ${escape(t.plan.files.join(", "))}<br>No network · 15s test limit · Once · expires ${new Date(t.plan.expiresAt).toLocaleTimeString()}<br><code>Plan ${escape(t.plan.digest.slice(0, 16))} · revision ${t.revision}</code></div><div class="actions"><button id="revise-plan">Revise request</button><button id="approve-plan" class="primary">${t.plan.kind === "patch" ? "Apply patch & retest" : "Confirm cases & run test"}</button></div></section>`;
  }
  if (t.status === "review_required")
    content +=
      '<section class="card"><h4>The confirmed cases passed.</h4><p class="summary">Review the evidence below. This verifies the demo cases; nothing was merged, published or deployed.</p><div class="actions"><button id="export-review">Export review artifact</button><button id="accept-result" class="primary">Accept result</button></div></section>';
  if (t.status === "completed")
    content +=
      '<section class="card"><h4>Work accepted.</h4><p class="summary">The result and its evidence are saved locally.</p><div class="actions"><button id="export-review">Export review artifact</button><button id="save-memory">Save to memory</button></div></section>';
  if (t.status === "reconciliation_required")
    content +=
      '<section class="card"><h4>The worker restarted during an attempt.</h4><p class="summary">An outcome may be uncertain. The app will not replay the mutation. Start a fresh acceptance revision, or cancel and inspect the workspace.</p><button id="reconcile">Start a fresh revision</button></section>';
  if (t.error) content += `<p class="source">${escape(t.error)}</p>`;
  if (t.status === "failed")
    content +=
      '<p class="summary">No success is claimed. Review the error, then revise the request to prepare a new bounded attempt.</p>';
  const evidence = t.evidence
    .map(
      (e, i) =>
        `<div class="evidence"><strong class="${e.exitCode === 0 ? "pass" : "fail"}">${e.exitCode === 0 ? "Passed" : "Failed"} · attempt ${i + 1}</strong><p>${e.sandboxed ? "Observed macOS sandbox execution" : "Fixture adapter evidence"} · exit ${escape(e.exitCode)} · ${escape(e.durationMs ?? "unknown")} ms</p><pre>${escape(e.output)}</pre><details><summary>Evidence identity</summary><code>Source ${escape(e.sourceHash)}<br>Output ${escape(e.outputHash)}<br>${escape(e.observedAt)}</code></details></div>`,
    )
    .join("");
  const closed = ["completed", "cancelled"].includes(t.status);
  $("#detail").innerHTML =
    `<div class="source"><small>${escape(provenance)}</small>${escape(t.text)}</div><span class="badge ${t.status.includes("approval") ? "wait" : ""}">${escape(titles[t.status] ?? t.status)}</span><h3>${escape(t.status === "clarifying" ? "Let’s make sure we mean the same thing." : titles[t.status])}</h3>${content}${evidence ? "<h4>Observed evidence</h4>" + evidence : ""}<details><summary>What happened · ${t.events.length} updates</summary><ol class="timeline">${t.events.map((e) => `<li><time>${new Date(e.at).toLocaleTimeString()}</time>${escape(e.message)}</li>`).join("")}</ol></details>${!closed ? `<details id="steer-details"><summary>Change this request</summary><label for="steering">Revised request</label><textarea id="steering" rows="3" maxlength="8192">${escape(t.text)}</textarea><button id="steer">Confirm revision</button><p class="subtle">Revising invalidates prior approvals. Pause an active attempt first.</p></details><div class="task-controls">${t.status === "paused" ? '<button id="resume">Resume</button>' : '<button id="pause">Pause</button>'}<button id="cancel">Cancel work</button></div>` : ""}`;
  const bind = (s, fn) => {
    const el = $(s);
    if (el) el.onclick = fn;
  };
  bind("#confirm-cases", () =>
    command("confirm", {
      inclusive: $("#inclusive").checked,
      excludeCompleted: $("#exclude").checked,
    }),
  );
  bind("#approve-plan", () => command("approve", { digest: t.plan.digest }));
  bind("#revise-plan", () => {
    $("#steer-details").open = true;
    $("#steering").focus();
  });
  bind("#steer", () => command("steer", { text: $("#steering").value }));
  for (const c of ["pause", "resume", "cancel", "accept"])
    bind(c === "accept" ? "#accept-result" : "#" + c, () => command(c));
  bind("#reconcile", () => command("reconcile"));
  bind("#save-memory", () =>
    act(async () => {
      await api("memory", { action: "save", taskId: t.id });
      await refresh();
      error("");
    }),
  );
  bind("#export-review", () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            task: t,
            scope: "Isolated reminder demo. No publish or merge.",
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "companion-review-" + t.id.slice(0, 8) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}
function navigate(next) {
  
  clearMemoryFeedbacks();
  if (errorScope === "action") error("");
  contextOptions.open = false;
  page = next;
  for (const p of ["inbox", "work", "companion", "memory", "connections"])
    $("#" + p + "-page").hidden = p !== page;
  document.querySelectorAll("[data-page]").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === page);
    if (b.dataset.page === page) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#page-title").textContent = {
    inbox: "From Bee",
    work: "Tasks",
    companion: "BeeBot",
    memory: "Memory",
    connections: "Connections",
  }[page];
  $("#header-subtitle").textContent =
    page === "companion"
      ? ""
      : page === "work"
        ? ""
        : page === "memory"
          ? "Explicitly saved context"
          : "Access you control";
  if (page === "memory") renderMemory();
  if (page === "companion") renderConversations();
  if (page === "inbox") renderInbox();
}
function localDateTime(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function renderMemory() {
  const key = JSON.stringify(state.memories);
  if (key === memoryKey && $("#memories").children.length) return;
  memoryKey = key;
  clearMemoryFeedbacks();
  memoryFeedbacks.clear();
  $("#memories").innerHTML = state.memories.length
    ? state.memories
        .map(
          (m) =>
            `<article class="memory"><div><p>${escape(m.text)}</p><small>${escape(m.purpose)} · ${new Date(m.savedAt).toLocaleDateString()} · revision ${m.revision ?? 1}${m.expiresAt ? " · expires " + new Date(m.expiresAt).toLocaleDateString() : ""}</small><details><summary>Source and retention</summary><code>Accepted request ${escape(m.source)}</code><p class="subtle">Deleting this item revokes pending plans. Earlier task and conversation evidence remains.</p></details></div><div><button data-edit="${escape(m.id)}">Edit</button><button data-delete="${escape(m.id)}">Remove</button></div></article>`,
        )
        .join("")
    : '<div class="empty"><h3>Nothing saved yet</h3><p>Accept a task result, then choose Remember for future tasks. Only context you choose is kept here.</p></div>';
  document.querySelectorAll("[data-edit]").forEach(
    (b) =>
      (b.onclick = () => {
        const m = state.memories.find((x) => x.id === b.dataset.edit);
        const article = b.closest("article");
        const initialExpiry = m.expiresAt ? localDateTime(m.expiresAt) : "";
        const expiryId = "memory-expiry-" + m.id;
        article.innerHTML = `<form data-memory-form><label for="memory-edit-text-${escape(m.id)}">Saved context</label><textarea id="memory-edit-text-${escape(m.id)}" required maxlength="8192">${escape(m.text)}</textarea><label for="${escape(expiryId)}">Expires (optional local date/time)</label><input id="${escape(expiryId)}" type="datetime-local" value="${escape(initialExpiry)}" aria-describedby="${escape(expiryId)}-help ${escape(expiryId)}-error"><p id="${escape(expiryId)}-help" class="subtle">Choose a future date and time, or leave expiry empty.</p><p id="${escape(expiryId)}-error" data-memory-expiry-error role="alert" hidden></p><p data-memory-form-error role="alert" hidden></p><div class="actions"><button>Save changes and revoke pending plans</button><button type="button" data-clear-expiry>Clear expiry</button><button type="button" data-cancel-memory>Cancel</button></div></form>`;
        const expiry = article.querySelector("input");
        const feedback = createMemoryFeedback({
          expiry,
          expiryError: article.querySelector("[data-memory-expiry-error]"),
          formError: article.querySelector("[data-memory-form-error]"),
        });
        memoryFeedbacks.add(feedback);
        expiry.addEventListener("input", feedback.clear);

        article.querySelector("[data-clear-expiry]").onclick = () => {
          article.querySelector("input").value = "";
          feedback.clear();
        };
        article.querySelector("[data-cancel-memory]").onclick = () => {
          feedback.clear();
          memoryFeedbacks.delete(feedback);
          memoryKey = "";
          renderMemory();
          [...document.querySelectorAll("[data-edit]")]
            .find((x) => x.dataset.edit === m.id)
            ?.focus();
        };
        article.querySelector("textarea").focus();
        article.querySelector("form").onsubmit = (e) => {
          e.preventDefault();
          act(async () => {
            feedback.clear();
            const validation = memoryExpiryResult(expiry.value, {
              initialValue: initialExpiry,
              currentExpiry: m.expiresAt,
            });
            if (validation.error) {
              feedback.show("InvalidMemoryExpiry: " + validation.error);
              expiry.focus();
              return;
            }
            try {
              await api("memory", {
                action: "edit",
                id: m.id,
                text: article.querySelector("textarea").value,
                expiresAt: validation.expiresAt,
              });
            } catch (error) {
              feedback.show(error.message ?? error);
              if (expiry.getAttribute("aria-invalid") === "true")
                expiry.focus();
              return;
            }
            feedback.clear();
            memoryFeedbacks.delete(feedback);
            memoryKey = "";
            await refresh();
            document.querySelector(`[data-edit="${CSS.escape(m.id)}"]`)?.focus({ preventScroll: true });
          });
        };
      }),
  );
  document.querySelectorAll("[data-delete]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          await api("memory", { action: "delete", id: b.dataset.delete });
          await refresh();
          const target = $("#memories [data-edit]") ?? $("#memory-page h2");
          if (target.tagName === "H2") target.tabIndex = -1;
          target.focus({ preventScroll: true });
        })),
  );
}
function renderConnections() {
  const stream = beeStreamControls(state, { pending: streamPending });
  $("#start-bee").disabled = !stream.canStart;
  $("#stop-bee").disabled = !stream.canStop;
  $("#bee-stream-help").textContent = stream.help;
  $("#bee-discovery").checked =
    state.worker?.supervision?.discoveryEnabled === true;
  const supervision = state.worker?.supervision;
  $("#supervisor-status").textContent = supervision
    ? "In-app supervisor · " +
      (supervision.desiredStream ? "scoped stream requested" : "stream off") +
      " · " +
      (supervision.lastPollResult
        ? supervision.lastPollResult.refreshed +
          " selected sources refreshed, " +
          supervision.lastPollResult.failed +
          " failed"
        : "no source refresh yet") +
      (supervision.pollError ? " · " + supervision.pollError : "") +
      " · no system startup service installed"
    : "Background status unavailable";
  $("#provider-hint").textContent = state.provider.connected
    ? "connected"
    : "connect first";
  $("#codex-status").textContent = state.provider.connected
    ? "Connected through Codex · GPT-6 Luna"
    : "Not connected. Sign in to Codex first, then connect here.";
  $("#bee-status").textContent = state.bee.connected
    ? "Receiving Bee transcripts · capture/device provenance still requires verification"
    : state.bee.started
      ? "Waiting for Bee events"
      : state.bee.gap
        ? "Stream stopped or disconnected. Missed events need snapshot recovery."
        : "Not connected. No device capture verified.";
  const key = JSON.stringify(state.captures);
  if (key === capturesKey) return;
  capturesKey = key;
  $("#captures").innerHTML = state.captures.length
    ? "<h4>Context waiting for your selection</h4>" +
      state.captures
        .map(
          (c) =>
            `<article class="source"><p>${escape(c.text)}</p><button data-capture="${escape(c.id)}">Use this request</button></article>`,
        )
        .join("")
    : "";
  document.querySelectorAll("[data-capture]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          const capture = state.captures.find(
            (c) => c.id === b.dataset.capture,
          );
          const source = await api("bee/context", {
            action: "capture",
            captureId: capture.id,
          });
          await selectSource(source, capture.text, false);
        })),
  );
}
async function consent(title, copy) {
  $("#dialog-title").textContent = title;
  $("#dialog-copy").textContent = copy;
  const d = $("#confirm-dialog");
  const initiatingElement = document.activeElement;
  d.returnValue = "cancel";
  d.showModal();
  return await new Promise((resolve) => {
    const cancel = () => {
      d.returnValue = "cancel";
    };
    d.addEventListener("cancel", cancel);
    d.addEventListener(
      "close",
      () => {
        d.removeEventListener("cancel", cancel);
        if (initiatingElement?.isConnected)
          initiatingElement.focus({ preventScroll: true });
        resolve(d.returnValue === "yes");
      },
      { once: true },
    );
  });
}
$("#new-work").onclick = () => {
  initialConversationLoad = false;
  composing = true;
  conversationId = null;
  conversationKey = "";
  $("#conversation-new").checked = false;
  navigate("companion");
  renderConversations();
  $("#conversation-input").focus();
};
$("#new-request").onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    if (!online)
      throw Error(
        "Worker offline. This text is only a local draft; no queued request has been acknowledged.",
      );
    const text = $("#request").value;
    const t = await api("tasks", {
      text,
      provider: $("#use-codex").checked ? "codex" : "template",
    });
    selected = t.id;
    composing = false;
    $("#request").value = "";
    await refresh();
  });
};
$("#sample").onclick = () =>
  act(async () => {
    const t = await api("tasks", {
      text: "When a reminder is due exactly now, show it as due. Completed reminders must never be due.",
      fixture: true,
      provider: "template",
    });
    selected = t.id;
    composing = false;
    await refresh();
  });
document.querySelectorAll("[data-page]").forEach(
  (b) =>
    (b.onclick = () => {
      navigate(b.dataset.page);
      if (b.classList.contains("legacy-nav")) $(".legacy-demo").open = true;
    }),
);
$("#connect-codex").onclick = () =>
  act(async () => {
    await api("provider/connect", {});
    $("#login-link").textContent =
      "Using the existing official Codex connection · GPT-6 Luna only. No new sign-in started.";
    await refresh();
  });
$("#start-bee").onclick = () =>
  act(async () => {
    if (!beeStreamControls(state).canStart) {
      error(beeStreamError("SelectAndFollowMappedBeeConversationFirst"));
      return;
    }
    streamPending = true;
    renderConnections();
    try {
      if (
        !(await consent(
          "Start updates for followed conversations?",
          "This starts the signed-in Bee CLI. Only mapped conversations with active Follow are retained. Follow may prepare proposals within the scope you already approved; starting the stream grants no new scope or external actions. Continue?",
        ))
      )
        return;
      await api("bee/start", {});
      await refresh();
    } finally {
      streamPending = false;
      renderConnections();
    }
  });
$("#stop-bee").onclick = () =>
  act(async () => {
    await api("bee/stop", {});
    await refresh();
  });
$("#recover").onclick = () =>
  act(async () => {
    const source = await api("bee/context", {
      action: "recover",
      text: $("#recovered-text").value,
    });
    $("#recovered-text").value = "";
    await refresh();
    navigate("inbox");
    [...document.querySelectorAll("[data-source]")]
      .find((el) => el.dataset.source === source.id)
      ?.querySelector("textarea")
      ?.focus();
  });
await refresh();
navigate(page);
setInterval(refresh, 1500);

function renderConversations() {
  const all = visibleConversations();
  const list = developerMode ? all : taskNavigation(all).current;
  if (!developerMode && conversationId && all.some((c) => c.id === conversationId) && !list.some((c) => c.id === conversationId)) {
    composerDrafts.save();
    conversationId = list[0]?.id ?? null;
    composing = !conversationId;
    conversationKey = "";
  }
  if (initialConversationLoad && list.length) {
    initialConversationLoad = false;
    if (!conversationId) {
      const first = taskNavigation(list, hiddenConversations).current[0];
      if (first) { conversationId = first.id; composing = false; }
    }
  }
  if (!conversationId && !composing && list.length) conversationId = list[0].id;
  const c = list.find((x) => x.id === conversationId);
  composerDrafts.select(
    $("#conversation-new").checked ? null : (c?.id ?? null),
  );
  const listKey = JSON.stringify([hiddenConversations, list.map((x) => [x.id, taskTitle(x), x.mode, x.status])]);
  if (listKey !== recentKey) {
    recentKey = listKey;
    const groups = taskNavigation(list, hiddenConversations);
    const archived = all.filter(c=>c.presentationArchived && (developerMode || taskNavigation([{...c,presentationArchived:false}]).current.length));
    const row = (x, hidden = false) => `<div class="task-nav-row"><button data-conversation="${escape(x.id)}" title="${escape(x.messages[0]?.text)}"><span>${escape(taskTitle(x))}</span><small>${x.mode === "fixture" ? "Simulated · " : x.source?.type === "synthetic-evaluation" ? "Synthetic · " : ""}${escape(({completed:"Accepted",review_required:"Ready to review",thinking:"Preparing",clarifying:"Needs your input",paused:"Paused",failed:"Needs attention"})[x.status] ?? x.status.replaceAll("_", " "))}</small></button><button class="task-visibility" data-${hidden ? "restore" : "hide"}-conversation="${escape(x.id)}" aria-label="${hidden ? "Restore" : "Hide"} task: ${escape(taskTitle(x))}" title="${hidden ? "Restore task" : "Hide task"}">${hidden ? "↶" : "×"}</button></div>`;
    const navigation = groups.current.map((x) => row(x)).join("") +
      (developerMode && groups.examples.length ? `<details class="sidebar-examples"><summary>Examples · ${groups.examples.length}</summary>${groups.examples.map((x) => row(x)).join("")}</details>` : "") +
      (groups.hidden.filter((x) => developerMode || taskNavigation([x]).current.length).length ? `<details class="sidebar-examples"><summary>Hidden tasks · ${groups.hidden.filter((x) => developerMode || taskNavigation([x]).current.length).length}</summary>${groups.hidden.filter((x) => developerMode || taskNavigation([x]).current.length).map((x) => row(x, true)).join("")}</details>` : "");
    const archivedNavigation = archived.length ? `<details class="sidebar-examples"><summary>Archived tasks · ${archived.length}</summary>${archived.map(x=>row(x,true)).join("")}</details>` : "";
    $("#conversation-list").innerHTML = navigation + archivedNavigation;
    $("#mobile-conversation-list").innerHTML = navigation + archivedNavigation;
    document.querySelectorAll("[data-conversation]").forEach((b) => b.onclick = () => {
      $("#conversation-new").checked = false;
      conversationId = b.dataset.conversation;
      composing = false;
      conversationKey = "";
      $("#mobile-history").open = false;
      navigate("companion");
      renderConversations();
    });
    document.querySelectorAll("[data-hide-conversation], [data-restore-conversation]").forEach((b) => b.onclick = () => {
      const mobile = Boolean(b.closest("#mobile-conversation-list"));
      const hide = b.dataset.hideConversation;
      if(!hide){restoredArchivedTasks=[...new Set([...restoredArchivedTasks,b.dataset.restoreConversation])];try{localStorage.setItem("beebot.restored-tasks.v1",JSON.stringify(restoredArchivedTasks));}catch{}}
      hiddenConversations = hide ? [...new Set([...hiddenConversations, hide])] : hiddenConversations.filter((id) => id !== b.dataset.restoreConversation);
      persistHiddenConversations();
      renderConversations();
      // Hiding affects navigation only; the open task and its unsent draft stay put.
      const container = mobile ? "#mobile-conversation-list" : "#conversation-list";
      const candidate = document.querySelector(`${container} [data-conversation="${CSS.escape(conversationId ?? "")}"]`);
      const target = candidate?.getClientRects().length ? candidate : (mobile ? $("#mobile-history summary") : $("#new-work"));
      target.focus({preventScroll:true});
    });
  }
  document.querySelectorAll("[data-conversation]").forEach((b) => b.classList.toggle("selected", b.dataset.conversation === conversationId));
  const optionsKey = JSON.stringify(state.memories.map((m) => [m.id, m.text]));
  if (optionsKey !== memoryOptionsKey) {
    memoryOptionsKey = optionsKey;
    const memoryValue = $("#conversation-memory").value;
    $("#conversation-memory").innerHTML =
      '<option value="">＋ Saved context</option>' +
      state.memories
        .map(
          (m) =>
            `<option value="${escape(m.id)}">${escape(m.text.slice(0, 60))}</option>`,
        )
        .join("");
    $("#conversation-memory").value = state.memories.some(
      (m) => m.id === memoryValue,
    )
      ? memoryValue
      : "";
  }
  $("#conversation-memory").disabled =
    Boolean(c) && !$("#conversation-new").checked;
  $("#conversation-memory-help").textContent =
    c && !$("#conversation-new").checked
      ? "Saved context can be attached when starting a new task. This conversation keeps its original context."
      : "Choose saved context to include with your new task.";
  $("#capability-list").innerHTML = (state.capabilities ?? [])
    .map(
      (x) =>
        `<div><b>${escape(x.title)} · ${x.available ? "Available" : "Unavailable"}</b><p>${escape(x.scope)}</p></div>`,
    )
    .join("");
  $("#conversation-mode").textContent =
    c?.mode === "fixture"
      ? "Simulated · no model"
      : state.provider.connected
        ? "ChatGPT · GPT-6 Luna"
        : "GPT-6 Luna · existing Codex on request";
  if (page === "companion") {
    $("#page-title").textContent = c
      ? taskTitle(c)
      : "BeeBot";
    $("#header-subtitle").textContent = c
      ? ({
          failed: "This attempt failed",
          source_changed: "Bee context changed",
          interrupted: "Interrupted — review needed",
          clarifying: "Needs your input",
          waiting_source: "Waiting for Bee context",
          waiting_source_action: "Waiting for fresh Bee context",
          plan_review: "Needs approval",
          review_required: "Ready to review",
          thinking: "Thinking",
          acting: "Working",
          paused: "Paused",
          pausing: "Pausing",
          cancelling: "Cancelling",
          completed: "Accepted",
        }[c.status] ?? c.status)
      : "";
  }
  if (!c) {
    if (conversationKey === "empty") return;
    conversationKey = "empty";
    $("#conversation-detail").innerHTML =
      '<div class="empty-chat"><span class="empty-mark">' +
      icon("mark") +
      '</span><h2>What’s on your mind?</h2><p>Bring a thought from Bee, or tell me what you need.</p></div>' + (developerMode ? '<div class="empty-prompts"><button id="conversation-sample">Plan a workshop<small>Simulated conversation</small></button><button id="policy-sample">Try a coding example<small>Simulated · isolated policy test</small></button></div>' : '');
    if ($("#conversation-sample")) $("#conversation-sample").onclick = () =>
      act(async () => {
        const c = await api("conversation", {
          action: "create",
          text: "Help me plan a workshop.",
          mode: "fixture",
        });
        $("#conversation-new").checked = false;
        conversationId = c.id;
        composing = false;
        conversationKey = "";
        await refresh();
      });
    if ($("#policy-sample")) $("#policy-sample").onclick = () =>
      act(async () => {
        const c = await api("conversation", {
          action: "create",
          text: "Give cart totals of 100 or more a 10% discount.",
          mode: "fixture",
          fixtureKind: "policy",
        });
        $("#conversation-new").checked = false;
        conversationId = c.id;
        composing = false;
        conversationKey = "";
        await refresh();
      });
    return;
  }
  const announcement =
    c.id +
    ":" +
    c.status +
    ":" +
    c.steps.filter((s) => s.status === "completed").length;
  if (announcement !== announcementKey) {
    announcementKey = announcement;
    $("#conversation-announcement").textContent = conversationAnnouncement(
      c.status,
    );
  }
  const key = JSON.stringify(c);
  if (key === conversationKey) return;
  conversationKey = key;
  const sourceLabel =
    c.mode === "fixture"
      ? "Simulated conversation · deterministic fixture"
      : "Selected messages · ChatGPT proposal";
  let html =
    (c.source
      ? `<details class="task-source"><summary>${c.source.type === "synthetic-evaluation" ? "Synthetic task example · live GPT-6 Luna" : c.source.transport === "manual-recovery" ? "Pasted recovered context · provenance unverified" : c.source.simulated ? "Simulated Bee source" : "From Bee"}</summary><span>${escape(c.source.transport)} · revision ${c.source.revision}${c.source.recovered ? " · recovered context" : ""}</span>${c.source.type === "synthetic-evaluation" ? "" : '<button data-back-inbox class="quiet">View Bee context</button>'}</details>`
      : "") +
    (c.mode === "fixture" ? '<p class="chat-meta">Simulated conversation · no live model</p>' : "") +
    c.messages
      .map((m) =>
        m.role === "user"
          ? `<div class="message user"><div class="message-body"><p class="message-text">${escape(m.text)}</p></div></div>`
          : `<div class="message assistant"><span class="avatar" aria-hidden="true">${icon("mark")}</span><div class="message-body"><p class="message-text">${escape(m.text)}</p>${m.questions?.length && !m.questions.every((q) => m.text.includes(q)) ? '<ul class="clarification">' + m.questions.map((q) => "<li>" + escape(q) + "</li>").join("") + "</ul>" : ""}</div></div>`,
      )
      .join("");
  if (["waiting_source", "waiting_source_action"].includes(c.status))
    html +=
      '<p class="waiting">Waiting for a fresh check of the selected Bee conversation. Work stays saved; no cached-source model request or action starts. You can pause or cancel.</p>';
  if (c.status === "thinking")
    html +=
      renderLiveProposal(c,escape) || '<p class="waiting" role="status">Preparing your response…</p>';
  if (c.status === "acting")
    html +=
      '<p class="waiting" role="status">Running the approved isolated test…</p>';
  html += c.steps
    .map((s) => {
      const artifact = c.artifacts.find((a) => a.id === s.receipt?.artifactId);
      const done = s.status === "completed",
        unavailable = s.status === "unavailable";
      if (
        done &&
        artifact &&
        ["document", "checklist", "schedule"].includes(
          artifact.verification?.kind,
        )
      )
        return `<section class="draft-artifact" data-step-ui="${escape(s.id)}" data-outcome="completed"><h4><span>${escape(s.title)}</span><span class="artifact-status" aria-label="Draft prepared">${icon("check")}</span></h4><p class="subtle">Revision ${escape(String(artifact.plan?.revision ?? "unknown"))} · current result</p>${artifactBody(artifact, escape)}<details class="trace"><summary>Checks and provenance</summary>${artifact.verification.kind === "checklist" && c.artifacts.some((a) => a.id !== artifact.id && a.verification?.kind === "checklist") ? '<p>New revision. Earlier checks stay with their original version in history.</p>' : ""}<p>${escape(artifact.verification.checks.join(" · "))}</p><p>Prepared privately within your request. No external action.</p><code>${escape(artifact.digest.slice(0, 16))}</code></details></section>`;
      if (done)
        return `<div class="draft-artifact" data-step-ui="${escape(s.id)}" data-outcome="completed"><h4><span>${escape(s.title)}</span><span class="artifact-status" aria-label="Draft prepared">${icon("check")}</span></h4><p class="subtle">${s.capability === "demo.policy" ? "Proposed cases passed · review against your request" : "Private draft prepared on this Mac · review before use"}</p><details><summary>View result and evidence</summary>${artifact && ["document", "checklist", "schedule"].includes(artifact.verification?.kind) ? artifactBody(artifact, escape) : s.capability === "local.document" ? draftContent(s.content, escape) : (s.evidence ?? []).map((e) => '<div class="evidence">Actual sandbox · exit ' + e.exitCode + "<pre>" + escape(e.output) + "</pre></div>").join("")}<code>Plan ${escape(s.digest.slice(0, 16))}</code></details></div>`;
      const recipe = s.recipe;
      const preview = recipe
        ? '<div class="plan-copy">' +
          recipe.cases
            .map(
              (x) =>
                '<div class="case"><span>' +
                escape(x.name) +
                "<small>" +
                escape(JSON.stringify(x.input)) +
                "</small></span><b>" +
                escape(JSON.stringify(x.expected)) +
                "</b></div>",
            )
            .join("") +
          "</div>"
        : draftContent(s.content, escape);
      return `<section class="inline-plan" data-step-ui="${escape(s.id)}" data-outcome="${escape(s.status)}"><div class="plan-header"><h3>${escape(s.title)}</h3><span class="plan-status">${unavailable ? "Unavailable" : s.status === "running" ? "Running" : s.status === "queued" ? "Queued" : s.status === "failed" ? "Failed" : s.stage === "patch" ? "Fix needs approval" : "Needs approval"}</span></div>${preview}${s.error ? "<p role=alert>" + escape(s.error) + "</p>" : ""}<div class="plan-scope"><span class="scope-chip">${s.capability === "demo.policy" ? "Isolated demo" : "Local draft only"}</span><span class="scope-chip">Once · 10 min</span><span class="scope-chip">${s.dependsOn.length ? "After " + escape(s.dependsOn.join(", ")) : "No external send"}</span></div><details class="trace"><summary>${s.sourceAfter ? "Exact change and test evidence" : "Approval scope and provenance"}</summary><p>${escape(s.scope)}</p>${s.sourceAfter ? '<p class="subtle">Generated-policy demo: the disposable baseline intentionally returns null. Cases and expression come from one proposal; passing those cases is not independent proof of the requirement.</p><pre>' + escape("- " + s.sourceBefore + "+ " + s.sourceAfter) + "</pre><pre>" + escape(JSON.stringify(s.recipe.cases, null, 2)) + "</pre>" : ""}${(s.evidence ?? []).map((e) => '<div class="evidence">Actual sandbox · exit ' + e.exitCode + "<pre>" + escape(e.output) + "</pre></div>").join("")}<code>Plan ${escape(s.digest)} · revision ${s.revision} · expires ${new Date(s.expiresAt).toLocaleTimeString()}</code></details>${s.status === "approval_required" ? `<div class="plan-actions"><button data-plan-revise class="quiet">Revise</button>${s.capability === "demo.policy" && s.stage === "test" ? '<details><summary>Add your own acceptance examples</summary><p>Optional independent checks: JSON cases with name, input and expected. Conflicting expectations require a corrected proposal.</p><textarea data-owner-checks="' + escape(s.digest) + '" rows="3" aria-label="Your own acceptance examples"></textarea></details>' : ""}<button data-step="${escape(s.digest)}" class="primary">${s.capability === "demo.policy" ? (s.stage === "patch" ? "Approve patch & retest" : "Confirm cases & run test") : "Approve this draft"}</button></div>` : ""}</section>`;
    })
    .join("");
  const history = renderArtifactHistory(c, escape);
  if (
    [
      "paused",
      "pausing",
      "cancelling",
      "cancelled",
      "interrupted",
    ].includes(c.status)
  )
    html +=
      '<p class="waiting">' +
      escape(
        {
          paused: "Paused. Prior unused plans are revoked.",
          pausing: "Pause requested. Waiting for the worker.",
          cancelling: "Cancellation requested. Waiting for the worker.",
          cancelled: "Cancelled. Existing evidence is retained.",
          completed: "You accepted these results.",
          interrupted:
            "Worker restarted. Outcome needs review; no action was replayed.",
        }[c.status],
      ) +
      "</p>";
  if (c.status === "review_required")
    html +=
      '<section class="result-review" aria-label="Review results"><div><strong>How does this look?</strong><p>Review the result, or tell me what to change.</p></div><div class="review-actions"><button data-conversation-control="accept" class="primary">Accept results</button><button data-request-change class="quiet">Make a change</button></div></section>';
  if (c.status === "completed")
    html +=
      '<section class="result-accepted" role="status"><strong>Saved to task</strong><span class="accepted-status">' + icon("check") + ' Accepted</span><button data-save-conversation-memory class="quiet">Remember for future tasks</button></section>';
  if (c.error)
    html += `<div class="source" role="alert">${escape(c.error)}</div>`;
  if (c.status === "source_changed")
    html +=
      '<p class="source">Saved context changed. Pending plans are revoked. Start a new conversation; earlier messages remain evidence.</p>';
  if (!["cancelled", "completed"].includes(c.status))
    html +=
      '<details class="task-options"' + (["thinking","acting","queued","pausing","cancelling","waiting_source","waiting_source_action"].includes(c.status) ? ' open' : '') + '><summary>Task controls</summary><div class="task-controls">' +
      (c.status === "failed"
        ? "<button data-conversation-retry>Try again</button>"
        : c.status === "paused"
          ? '<button data-conversation-control="resume">' +
            icon("work") +
            " Resume with a fresh proposal</button>"
          : '<button data-conversation-control="pause">' +
            icon("pause") +
            " Pause</button>") +
      '<button data-conversation-control="cancel">Cancel</button></div></details>';
  html += '<details class="task-history"><summary>History</summary>' + history;
  html += `<details class="trace"><summary>Activity · ${c.events.filter((e) => e.type !== "delta").length} events</summary><button id="export-conversation" class="quiet">Export review evidence</button><ol class="timeline">${c.events
    .filter((e) => e.type !== "delta")
    .map((e) => "<li>" + escape(e.text) + "</li>")
    .join(
      "",
    )}</ol>${c.stream ? "<details><summary>Live structured draft · untrusted</summary><pre>" + escape(c.stream) + "</pre></details>" : ""}</details></details>`;
  const previousId = $("#conversation-detail").dataset.conversation;
  const historyWasOpen = $("#conversation-detail .artifact-history")?.open;
  const taskHistoryWasOpen = $("#conversation-detail .task-history")?.open;
  const previous = new Map(
    [...document.querySelectorAll("[data-step-ui]")].map((el) => [
      el.dataset.stepUi,
      el.dataset.outcome,
    ]),
  );
  const scroll = $(".chat-scroll"),
    follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  $("#conversation-detail").innerHTML = html;
  $("#conversation-detail").dataset.conversation = c.id;
  if (previousId === c.id && taskHistoryWasOpen && $("#conversation-detail .task-history")) $("#conversation-detail .task-history").open = true;
  if (previousId === c.id && historyWasOpen && $("#conversation-detail .artifact-history")) $("#conversation-detail .artifact-history").open = true;
  const changeButton = document.querySelector("[data-request-change]");
  if (changeButton) changeButton.onclick = () => $("#conversation-input").focus();
  if (
    previousId === c.id &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches &&
    lastInput !== "keyboard"
  ) {
    for (const el of document.querySelectorAll("[data-step-ui]"))
      if (
        previous.has(el.dataset.stepUi) &&
        previous.get(el.dataset.stepUi) !== el.dataset.outcome
      )
        el.animate(
          [
            { opacity: 0.55, transform: "translateY(3px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 150, easing: "cubic-bezier(.2,0,0,1)" },
        );
  }
  if (follow) scroll.scrollTop = scroll.scrollHeight;
  const exportButton = $("#export-conversation");
  if (exportButton)
    exportButton.onclick = () => {
      const blob = new Blob([JSON.stringify(c, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "beebot-task-" + c.id.slice(0, 8) + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  const cmd = (type, extra = {}) =>
    act(async () => {
      await api("conversation", {
        action: "command",
        id: c.id,
        command: {
          id: crypto.randomUUID(),
          version: c.version,
          type,
          ...extra,
        },
      });
      await refresh();
      if (lastInput === "keyboard") {
        const approvedId = c.steps.find((s) => s.digest === extra.digest)?.id;
        const heading = extra.digest
          ? [...document.querySelectorAll("[data-step-ui]")]
              .find((el) => el.dataset.stepUi === approvedId)
              ?.querySelector("h4")
          : null;
        const target = heading ?? $("#conversation-input");
        if (heading) heading.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    });
  document.querySelectorAll("[data-step]").forEach(
    (b) =>
      (b.onclick = () => {
        try {
          const raw = document
            .querySelector('[data-owner-checks="' + b.dataset.step + '"]')
            ?.value.trim();
          cmd("approve", {
            digest: b.dataset.step,
            acceptanceCases: raw ? JSON.parse(raw) : [],
          });
        } catch {
          error(
            "Enter valid JSON acceptance cases, or clear the optional examples.",
          );
        }
      }),
  );
  document.querySelectorAll("[data-checklist-item]").forEach(
    (input) =>
      (input.onchange = () =>
        cmd("checklist-item", {
          artifactId: input.dataset.checklistArtifact,
          itemId: input.dataset.checklistItem,
          done: input.checked,
        })),
  );
  const saveMemory = document.querySelector("[data-save-conversation-memory]");
  if (saveMemory)
    saveMemory.onclick = () =>
      act(async () => {
        await api("memory", {
          action: "save-conversation",
          conversationId: c.id,
          version: c.version,
        });
        await refresh();
        $("#conversation-announcement").textContent =
          "Accepted request saved to memory.";
      });
  const retry = document.querySelector("[data-conversation-retry]");
  if (retry)
    retry.onclick = () =>
      act(async () => {
        await api("conversation", {
          action: "send",
          id: c.id,
          version: c.version,
          text: "Please propose a fresh plan.",
        });
        await refresh();
      });
  document
    .querySelectorAll("[data-conversation-control]")
    .forEach((b) => (b.onclick = () => cmd(b.dataset.conversationControl)));
  document.querySelectorAll("[data-plan-revise]").forEach(
    (b) =>
      (b.onclick = () => {
        $("#conversation-input").focus();
        $("#conversation-input").placeholder = "Tell me what to change…";
      }),
  );
}
$("#conversation-form").onsubmit = (e) => {
  e.preventDefault();
  
  act(async () => {
    const current = (state.conversations ?? []).find(
      (c) => c.id === conversationId,
    );
    const fresh = $("#conversation-new").checked || !current;
    const submittedText = $("#conversation-input").value;
    const submittedId = fresh ? null : current.id;
    const c = await api(
      "conversation",
      fresh
        ? {
            action: "create",
            text: submittedText,
            mode: "codex",
            memoryIds: $("#conversation-memory").value
              ? [$("#conversation-memory").value]
              : [],
          }
        : {
            action: "send",
            id: current.id,
            version: current.version,
            text: submittedText,
          },
    );
    composerDrafts.acknowledge(submittedId, submittedText);
    conversationId = c.id;
    $("#conversation-new").checked = false;
    await refresh();
  });
};
const events = new EventSource("/api/events");
let scheduled = false;
events.onmessage = () => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    refresh();
  }, 80);
};

$("#conversation-new").onchange = () => {
  conversationKey = "";
  renderConversations();
};

window.addEventListener("resize", () => {
  if (page === "companion") {
    const scroll = $(".chat-scroll");
    scroll.scrollTop = scroll.scrollHeight;
  }
});

async function selectSource(source, goal, follow) {
  if (!goal.trim())
    throw Error("Describe the task you want to start from this context.");
  if (
    !source.simulated &&
    !(await consent(
      "Use this selected Bee context with GPT-6 Luna?",
      "Send the following selected context and your request to OpenAI through the existing Codex connection for preparation. " +
        (source.transport === "manual-recovery"
          ? "Pasted recovered context · provenance unverified. "
          : "") +
        (follow
          ? "Follow sends new context from only this conversation for up to six proposals over 24 hours while this Mac is running. "
          : "") +
        "No action is automatically approved.\n\nSelected context:\n" +
        source.text +
        "\n\nYour request:\n" +
        goal,
    ))
  )
    return;
  let result;
  try {
    result = await api("bee/context", {
      action: "select",
      id: source.id,
      revision: source.revision,
      contextDigest: source.contextDigest,
      goal,
      confirmed: true,
      follow,
      providerConsent: source.simulated ? undefined : "codex-openai",
    });
  } catch (failure) {
    if (
      failure.message !== "SourceAlreadyClaimedWithDifferentIntent" ||
      !failure.existingConversationId
    )
      throw failure;
    if (
      !(await consent(
        "This source already has a task",
        "Your changed request has not been submitted. Open the existing conversation to review it and send your changed request there?",
      ))
    )
      return;
    result = { conversationId: failure.existingConversationId };
    composerDrafts.select(result.conversationId);
    $("#conversation-input").value = goal;
    composerDrafts.save();
  }
  $("#conversation-new").checked = false;
  conversationId = result.conversationId;
  composing = false;
  conversationKey = "";
  await refresh();
  navigate("companion");
}
document
  .querySelector("#bee-source-list")
  .addEventListener("input", (event) => {
    const article = event.target.closest("[data-source]");
    if (!article) return;
    inboxDrafts.set(article.dataset.source, {
      goal: article.querySelector("[data-source-goal]").value,
      follow: article.querySelector("[data-follow-source]").checked,
    });
  });
function renderInbox() {
  $("#inbox-connection").textContent = "Read locally. Share only after confirmation.";
  const sources = (state.sources ?? []).filter((source) => developerMode || !source.simulated);
  const visibleSources = selectedBeeSource && sources.some(s=>s.id===selectedBeeSource) ? sources.filter(s=>s.id===selectedBeeSource) : sources.filter(s=>showArchivedBeeSources || !s.presentationArchived);
  const key = JSON.stringify([state.sources, state.follows,selectedBeeSource,showArchivedBeeSources]);
  if (key === inboxKey) return;
  inboxKey = key;
  const olderCount=sources.filter(s=>s.id!==selectedBeeSource && (s.presentationArchived || selectedBeeSource)).length;
  $("#inbox-archive").innerHTML=olderCount?`<button class="quiet" id="show-older-sources">Show older imports · ${olderCount}</button>`:"";
  const showOlder=$("#show-older-sources");if(showOlder)showOlder.onclick=()=>{selectedBeeSource=null;sessionStorage.removeItem("beebot.selected-source.v1");showArchivedBeeSources=true;inboxKey="";renderInbox();};
  const container = $("#bee-source-list");
  const previous = new Map(
    [...container.querySelectorAll("[data-source]")].map((article) => [
      article.dataset.source,
      article,
    ]),
  );
  const focus = document.activeElement;
  const focusedSource = focus.closest?.("[data-source]")?.dataset.source;
  const focusedGoal = focus.matches?.("[data-source-goal]");
  const selection = focusedGoal
    ? [focus.selectionStart, focus.selectionEnd]
    : null;
  const template = document.createElement("template");
  template.innerHTML = visibleSources.length
    ? visibleSources
        .map(
          (s) =>
            `<article class="bee-source" data-source="${escape(s.id)}"><div class="source-heading"><b>${escape((/^Bee summary: ([^\n]+)/.exec(s.text)?.[1] ?? s.text.replace(/\s+/g," ")).slice(0,115))}</b><span>${s.transport === "manual-recovery" ? "Recovered excerpt · provenance unverified" : s.simulated ? "Simulated Bee source" : "From Bee"} · ${escape(new Date(s.receivedAt).toLocaleString())}</span></div><details class="source-transcript"><summary>Read transcript</summary><blockquote>${escape(s.text)}</blockquote></details>${s.claimRecoveryError ? `<p role="alert">${escape(s.claimRecoveryError.message)}</p>` : ""}<label>What would you like to do?<textarea data-source-goal rows="2" maxlength="2000" placeholder="Prepare a plan, draft or checklist…">${s.simulated ? "Turn this requirement into confirmed acceptance conditions, a test and a proposed fix." : ""}</textarea></label><p data-source-feedback role="alert" hidden></p><button class="primary" data-select-source="${escape(s.id)}">Start task</button><details class="source-options"><summary>Follow and source details</summary><label class="check"><input type="checkbox" data-follow-source> ${s.simulated ? "Follow fixture changes for 24 hours · up to 6 local proposals" : "Follow this conversation for 24 hours · up to 6 GPT-6 Luna proposals"}</label><p class="subtle">${(state.follows ?? []).some((f) => f.source === s.id) ? ((state.follows ?? []).find((f) => f.source === s.id).pausedReason ? "Follow paused: " + escape((state.follows ?? []).find((f) => f.source === s.id).pausedReason) + ". " : "Following selected changes · proposals only. ") : ""}Source revision ${s.revision} · ${escape(s.transport)}${s.recovered ? " · recovered" : ""}. This context is not permission to act.</p><div class="actions"><button class="quiet" data-stop-follow="${escape(s.id)}" ${(state.follows ?? []).some((f) => f.source === s.id) ? "" : "hidden"}>Stop following</button><button class="quiet" data-delete-source="${escape(s.id)}">Clear source</button></div><p class="subtle">Clearing revokes pending work using this context. Earlier task history remains.</p></details></article>`,
        )
        .join("")
    : '<div class="inbox-empty"><span class="empty-mark">' +
      icon("mark") +
      "</span><h3>Bring a conversation from Bee</h3><p>Choose a recent conversation above, then tell BeeBot what you want to do with it.</p></div>";
  const desired = [...template.content.children];
  resetRemovedInboxFollowChoices(inboxDrafts, previous, state.sources ?? []);
  if (!desired.some((el) => el.hasAttribute("data-source"))) {
    container.replaceChildren(...desired);
  } else {
    container.querySelector(".inbox-empty")?.remove();
    const sources = visibleSources;
    for (const article of desired) {
      const id = article.dataset.source,
        old = previous.get(id);
      const sourceKey = JSON.stringify([
        sources.find((source) => source.id === id),
        (state.follows ?? []).filter((f) => f.source === id),
      ]);
      if (old?.dataset.renderKey === sourceKey) continue;
      article.dataset.renderKey = sourceKey;
      const draft = inboxDrafts.get(id);
      if (draft) {
        article.querySelector("[data-source-goal]").value = draft.goal;
        article.querySelector("[data-follow-source]").checked = draft.follow;
      }
      if (old) {
        for (const selector of [".source-options", ".source-transcript"]) if (old.querySelector(selector)?.open) article.querySelector(selector).open = true;
        old.replaceWith(article);
      }
      else container.append(article);
    }
    for (const [id, article] of previous)
      if (!sources.some((source) => source.id === id)) article.remove();
    if (focusedSource && !focus.isConnected) {
      const article = [...container.children].find(
        (el) => el.dataset.source === focusedSource,
      );
      const selector = focusedGoal
        ? "[data-source-goal]"
        : focus.matches(".source-options > summary") ? ".source-options > summary"
        : focus.matches(".source-transcript > summary") ? ".source-transcript > summary"
        : focus.matches("[data-follow-source]")
          ? "[data-follow-source]"
          : "[" +
            [...focus.attributes].find((a) => a.name.startsWith("data-"))
              ?.name +
            "]";
      const next = article?.querySelector(selector);
      next?.focus({ preventScroll: true });
      if (selection) next?.setSelectionRange(...selection);
    }
  }
  if (focusedSource && !focus.isConnected && ![...container.children].some((article) => article.dataset.source === focusedSource)) $("#bee-list-recent").focus({ preventScroll: true });
  document.querySelectorAll("[data-select-source]").forEach((b)=>b.onclick=()=>{
    const article=b.closest("[data-source]"),input=article.querySelector("[data-source-goal]"),feedback=article.querySelector("[data-source-feedback]");
    if(!input.value.trim()){
      feedback.textContent='Tell BeeBot what to prepare, for example: "Prepare the workshop agenda and checklist from this request."';feedback.hidden=false;input.setAttribute("aria-invalid","true");input.focus();return;
    }
    feedback.hidden=true;input.removeAttribute("aria-invalid");
    act(async()=>{await selectSource(state.sources.find(s=>s.id===b.dataset.selectSource),input.value,article.querySelector("[data-follow-source]").checked);});
  });
  document.querySelectorAll("[data-stop-follow]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          await api("bee/context", {
            action: "stop-follow",
            id: b.dataset.stopFollow,
          });
          resetInboxFollowChoice(
            inboxDrafts,
            b.dataset.stopFollow,
            b.closest("[data-source]"),
          );
          await refresh();
        })),
  );
  document.querySelectorAll("[data-delete-source]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          if (
            !(await consent(
              "Clear source and revoke pending work?",
              "The inbox text and pending source snapshots are cleared. Historical task messages, approved artifacts and audit evidence remain. This does not erase all prior captures or conversations.",
            ))
          )
            return;
          await api("bee/context", {
            action: "delete",
            id: b.dataset.deleteSource,
          });
          resetInboxFollowChoice(
            inboxDrafts,
            b.dataset.deleteSource,
            b.closest("[data-source]"),
          );
          await refresh();
        })),
  );
}
$("#bee-replay").onclick = () =>
  act(async () => {
    await api("bee/context", { action: "replay" });
    await refresh();
  });
$("#bee-mcp-connect").onclick = () =>
  act(async () => {
    if (
      !(await consent(
        "Connect local Bee MCP?",
        "Launch the installed Bee CLI using its existing login. This does not register a persistent connector or start login. Only the listed read tools are available; each context read is explicit and stays local until you choose to start a task.",
      ))
    )
      return;
    await api("bee/context", { action: "connect" });
    await refresh();
  });
$("#bee-read").onclick = () =>
  act(async () => {
    if (
      !(await consent(
        "Read this Bee conversation?",
        "Read only this chosen conversation using the official CLI and existing login into this local inbox. It will not be sent to a model until you select it as a task.",
      ))
    )
      return;
    await api("bee/context", {
      action: "read",
      conversationId: $("#bee-conversation-id").value,
    });
    await refresh();
  });
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-back-inbox]")) navigate("inbox");
});

function renderOwnership() {
  const current = taskNavigation(visibleConversations()).current;
  const key = JSON.stringify(current.map((c) => [c.id, c.version, c.status]));
  if (key === ownershipKey) return;
  ownershipKey = key;
  const label = (status) => ({completed:"Accepted",review_required:"Ready to review",plan_review:"Needs approval",clarifying:"Needs your input",thinking:"Preparing",queued:"Queued",paused:"Paused",failed:"Needs attention",waiting_source:"Waiting for Bee",waiting_source_action:"Waiting for Bee",source_changed:"Context changed",cancelled:"Cancelled",cancelling:"Cancelling",pausing:"Pausing",interrupted:"Needs review"})[status] ?? status.replaceAll("_", " ");
  const row = (c) => { const outputs = currentOutputCount(c); return `<button class="owned-task" data-owned-task="${escape(c.id)}"><span>${escape(taskTitle(c))}</span><small>${escape(label(c.status))}${outputs ? " · " + outputs + (outputs === 1 ? " output" : " outputs") : ""}</small></button>`; };
  const needs = current.filter((c) => ["review_required","clarifying","plan_review","failed","source_changed","interrupted"].includes(c.status));
  const done = current.filter((c) => ["completed","cancelled"].includes(c.status));
  const active = current.filter((c) => !needs.includes(c) && !done.includes(c));
  $("#ownership-list").innerHTML = '<h2>Tasks</h2><p class="page-description">Pick up a task, review a result or make a change.</p>' +
    (current.length ? [["Needs you",needs],["In progress",active],["Finished",done]].filter(([,items]) => items.length).map(([title,items]) => '<section class="task-group"><h3>'+title+'</h3>'+items.map(row).join("")+'</section>').join("") : '<div class="empty"><h3>No tasks yet</h3><p>Start with a Bee conversation or send BeeBot a request.</p></div>');
  document.querySelectorAll("[data-owned-task]").forEach(
    (b) =>
      (b.onclick = () => {
        $("#conversation-new").checked = false;
        conversationId = b.dataset.ownedTask;
        composing = false;
        conversationKey = "";
        navigate("companion");
      }),
  );
}
$("#bee-list-recent").onclick = () =>
  act(async () => {
    const result = await api("bee/context", { action: "list-recent" });
    $("#bee-recent-options").innerHTML = result.conversations.length
      ? result.conversations
          .map(
            (c) =>
              '<button class="owned-task" data-read-recent="' +
              escape(c.id) +
              '"><span>' +
              escape(
                c.title ||
                  c.summary?.slice(0, 120) ||
                  "Untitled Bee conversation",
              ) +
              "</span><small>" +
              escape(
                c.startTime
                  ? new Date(c.startTime).toLocaleString()
                  : "Time unavailable",
              ) +
              " · " +
              escape(beeSourceStatus(c.state)) +
              "</small></button>",
          )
          .join("")
      : '<p class="subtle">No recent conversations returned by Bee.</p>';
    document.querySelectorAll("[data-read-recent]").forEach(
      (b) =>
        (b.onclick = () =>
          act(async () => {
            const original=b.innerHTML;b.disabled=true;b.textContent="Loading conversation…";
            try {
              const source=await api("bee/context", {action:"read",conversationId:b.dataset.readRecent});
              selectedBeeSource=source.id;sessionStorage.setItem("beebot.selected-source.v1",source.id);inboxKey="";
              await refresh();
              const article=[...document.querySelectorAll("[data-source]")].find(el=>el.dataset.source===source.id);
              article?.scrollIntoView({block:"nearest"});article?.querySelector("[data-source-goal]")?.focus();
              b.setAttribute("aria-current","true");
            } finally {b.disabled=false;b.innerHTML=original;}
          })),
    );
  });

$("#bee-discovery").onchange = () =>
  act(async () => {
    const enabled = $("#bee-discovery").checked;
    if (
      enabled &&
      !(await consent(
        "Watch for new Bee conversations?",
        "Read up to five recent conversation metadata rows each minute and import newly completed conversations locally. No task or model call starts until you select context and approve sharing.",
      ))
    ) {
      await refresh();
      return;
    }
    await api("bee/discovery", { enabled, confirmed: true });
    await refresh();
  });
