(() => {
  "use strict";

  const API = {
    createJob: "/api/jobs",
    status: (id) => `/api/jobs/${id}/status`,
    result: (id) => `/api/jobs/${id}/result`,
    chat: (id) => `/api/jobs/${id}/chat`,
  };

  // -------------------------------------------------------------------
  // Elements
  // -------------------------------------------------------------------
  const jobForm = document.getElementById("jobForm");
  const submitBtn = document.getElementById("submitBtn");
  const submitBtnLabel = document.getElementById("submitBtnLabel");
  const formError = document.getElementById("formError");

  const tabs = document.querySelectorAll(".tab");
  const panes = document.querySelectorAll(".tab-pane");

  const dropzone = document.getElementById("dropzone");
  const videoFile = document.getElementById("videoFile");
  const dropzoneFilename = document.getElementById("dropzoneFilename");
  const videoUrl = document.getElementById("videoUrl");
  const languageSelect = document.getElementById("language");

  const pipelineSection = document.getElementById("pipelineSection");
  const sourceLabel = document.getElementById("sourceLabel");
  const progressFill = document.getElementById("progressFill");
  const stageList = document.getElementById("stageList");
  const elapsedTimeEl = document.getElementById("elapsedTime");
  const pipelineError = document.getElementById("pipelineError");

  const navDot = document.getElementById("navDot");
  const navStatusText = document.getElementById("navStatusText");

  const resultsSection = document.getElementById("resultsSection");
  const resultTitle = document.getElementById("resultTitle");
  const resultSummary = document.getElementById("resultSummary");
  const resultActionItems = document.getElementById("resultActionItems");
  const resultDecisions = document.getElementById("resultDecisions");
  const resultQuestions = document.getElementById("resultQuestions");
  const resultTranscript = document.getElementById("resultTranscript");
  const transcriptToggle = document.getElementById("transcriptToggle");
  const transcriptBody = document.getElementById("transcriptBody");

  const chatSection = document.getElementById("chatSection");
  const chatWindow = document.getElementById("chatWindow");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");

  let activeTab = "link";
  let currentJobId = null;
  let pollTimer = null;
  let clockTimer = null;
  let jobStartedAt = null;
  let stageNodes = {};

  // -------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      tabs.forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      panes.forEach((p) => p.classList.toggle("is-active", p.dataset.pane === activeTab));
      hideError();
    });
  });

  // -------------------------------------------------------------------
  // File upload / drag & drop
  // -------------------------------------------------------------------
  dropzone.addEventListener("click", () => videoFile.click());
  videoFile.addEventListener("change", () => {
    if (videoFile.files[0]) dropzoneFilename.textContent = videoFile.files[0].name;
  });
  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) {
      videoFile.files = e.dataTransfer.files;
      dropzoneFilename.textContent = file.name;
    }
  });

  // -------------------------------------------------------------------
  // Form submit -> create job
  // -------------------------------------------------------------------
  jobForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError();

    const language = languageSelect.value;
    const formData = new FormData();
    formData.append("language", language);

    let sourceLabelText = "";

    if (activeTab === "link") {
      const url = videoUrl.value.trim();
      if (!url) return showError("Paste a video link first.");
      formData.append("url", url);
      sourceLabelText = url;
    } else {
      const file = videoFile.files[0];
      if (!file) return showError("Choose a file to upload first.");
      formData.append("file", file);
      sourceLabelText = file.name;
    }

    setSubmitting(true);

    try {
      const res = await fetch(API.createJob, { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || "Could not start processing.");
      }
      const data = await res.json();
      currentJobId = data.job_id;
      startPipelineUI(sourceLabelText);
      pollStatus();
    } catch (err) {
      showError(err.message || "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  });

  function setSubmitting(isSubmitting) {
    submitBtn.disabled = isSubmitting;
    submitBtnLabel.textContent = isSubmitting ? "Starting…" : "Process video";
  }

  function showError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }
  function hideError() {
    formError.hidden = true;
    formError.textContent = "";
  }

  // -------------------------------------------------------------------
  // Pipeline UI
  // -------------------------------------------------------------------
  const FALLBACK_STAGES = [
    { key: "ingest", label: "Reading and chunking the source" },
    { key: "transcribe", label: "Transcribing audio" },
    { key: "title", label: "Generating a title" },
    { key: "summarize", label: "Summarizing the content" },
    { key: "extract", label: "Extracting action items, decisions and questions" },
    { key: "rag", label: "Preparing the chat assistant" },
  ];

  function startPipelineUI(sourceText) {
    pipelineSection.hidden = false;
    resultsSection.hidden = true;
    chatSection.hidden = true;
    pipelineError.hidden = true;
    sourceLabel.textContent = sourceText;
    progressFill.style.width = "0%";
    navDot.classList.add("is-active");
    navDot.classList.remove("is-done");
    navStatusText.textContent = "Processing…";

    renderStageNodes(FALLBACK_STAGES);

    jobStartedAt = Date.now();
    clearInterval(clockTimer);
    clockTimer = setInterval(updateClock, 1000);
    updateClock();

    pipelineSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderStageNodes(stages) {
    stageList.innerHTML = "";
    stageNodes = {};
    stages.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "stage-node";
      li.innerHTML = `
        <span class="stage-node__marker">${i + 1}</span>
        <span class="stage-node__label">${s.label}</span>
      `;
      stageList.appendChild(li);
      stageNodes[s.key] = li;
    });
  }

  function updateClock() {
    if (!jobStartedAt) return;
    const secs = Math.floor((Date.now() - jobStartedAt) / 1000);
    elapsedTimeEl.textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  function applyStageState(currentStageKey, stages) {
    const order = stages.map((s) => s.key);
    const currentIndex = order.indexOf(currentStageKey);
    order.forEach((key, i) => {
      const node = stageNodes[key];
      if (!node) return;
      node.classList.remove("is-active", "is-done");
      if (currentIndex === -1) return;
      if (i < currentIndex) node.classList.add("is-done");
      else if (i === currentIndex) node.classList.add("is-active");
    });
  }

  // -------------------------------------------------------------------
  // Poll job status
  // -------------------------------------------------------------------
  async function pollStatus() {
    clearTimeout(pollTimer);
    try {
      const res = await fetch(API.status(currentJobId));
      if (!res.ok) throw new Error("Lost track of this job.");
      const data = await res.json();

      progressFill.style.width = `${data.progress}%`;
      if (data.stages && data.stages.length) applyStageState(data.stage, data.stages);

      if (data.status === "error") {
        clearInterval(clockTimer);
        navDot.classList.remove("is-active");
        navStatusText.textContent = "Processing failed";
        pipelineError.hidden = false;
        pipelineError.textContent = data.error
          ? `Processing failed: ${data.error}`
          : "Processing failed. Please try again.";
        setSubmitting(false);
        return;
      }

      if (data.status === "done") {
        clearInterval(clockTimer);
        navDot.classList.remove("is-active");
        navDot.classList.add("is-done");
        navStatusText.textContent = "Ready";
        setSubmitting(false);
        await loadResult();
        return;
      }

      pollTimer = setTimeout(pollStatus, 1200);
    } catch (err) {
      pipelineError.hidden = false;
      pipelineError.textContent = "Lost connection while checking progress. Retrying…";
      pollTimer = setTimeout(pollStatus, 2500);
    }
  }

  // -------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------
  async function loadResult() {
    try {
      const res = await fetch(API.result(currentJobId));
      if (!res.ok) throw new Error("Could not load the result.");
      const data = await res.json();
      renderResult(data);
      resultsSection.hidden = false;
      chatSection.hidden = false;
      resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      pipelineError.hidden = false;
      pipelineError.textContent = err.message || "Could not load the result.";
    }
  }

  function renderList(container, items) {
    container.innerHTML = "";
    const list = normalizeToList(items);
    if (!list.length) {
      container.innerHTML = `<p class="empty">Nothing found here for this video.</p>`;
      return;
    }
    const ul = document.createElement("ul");
    list.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  function normalizeToList(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === "string") {
      return value
        .split("\n")
        .map((s) => s.replace(/^[-•\d.)\s]+/, "").trim())
        .filter(Boolean);
    }
    return [];
  }

  function renderResult(data) {
    resultTitle.textContent = data.title || "Untitled video";
    resultSummary.textContent = data.summary || "No summary available.";
    renderList(resultActionItems, data.action_items);
    renderList(resultDecisions, data.key_decisions);
    renderList(resultQuestions, data.open_questions);
    resultTranscript.textContent = data.transcript || "Transcript unavailable.";
  }

  transcriptToggle.addEventListener("click", () => {
    const expanded = transcriptToggle.getAttribute("aria-expanded") === "true";
    transcriptToggle.setAttribute("aria-expanded", String(!expanded));
    transcriptBody.hidden = expanded;
  });

  // -------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = chatInput.value.trim();
    if (!question || !currentJobId) return;

    addBubble("user", question);
    chatInput.value = "";
    chatSendBtn.disabled = true;
    const typingEl = addTyping();

    try {
      const res = await fetch(API.chat(currentJobId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json().catch(() => ({}));
      typingEl.remove();
      if (!res.ok) {
        addBubble("bot", data.detail || "I couldn't answer that just now.");
      } else {
        addBubble("bot", data.answer || "I don't have an answer for that.");
      }
    } catch (err) {
      typingEl.remove();
      addBubble("bot", "Connection issue — please try asking again.");
    } finally {
      chatSendBtn.disabled = false;
      chatInput.focus();
    }
  });

  function addBubble(role, text) {
    const div = document.createElement("div");
    div.className = `chat__bubble chat__bubble--${role === "user" ? "user" : "bot"}`;
    div.innerHTML = `<span class="chat__author">${role === "user" ? "You" : "Assistant"}</span>`;
    const textNode = document.createElement("span");
    textNode.textContent = text;
    div.appendChild(textNode);
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return div;
  }

  function addTyping() {
    const div = document.createElement("div");
    div.className = "chat__bubble chat__bubble--bot chat__bubble--typing";
    div.innerHTML = `<span class="chat__author">Assistant</span><span class="typing-dots"><span></span><span></span><span></span></span>`;
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return div;
  }
})();
