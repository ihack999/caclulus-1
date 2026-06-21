(function () {
  "use strict";

  const STORAGE_PROGRESS = "engineering-calc1-progress-v1";
  const STORAGE_YOUTUBE = "engineering-calc1-youtube-v1";
  const STORAGE_NOTES = "engineering-calc1-notes-v1";
  const STORAGE_UI = "engineering-calc1-ui-v1";
  const SUPABASE_TABLE = "user_course_state";
  const SYNCED_STORAGE_KEYS = new Set([STORAGE_PROGRESS, STORAGE_YOUTUBE, STORAGE_NOTES, STORAGE_UI]);
  const STATUS_FLOW = [
    ["not-started", "Not started"],
    ["watched", "Watched"],
    ["practiced", "Practiced"],
    ["got-stuck", "Got stuck"],
    ["reviewed", "Reviewed"],
    ["mastered", "Mastered"],
    ["exam-ready", "Exam ready"],
  ];
  const COMPLETE_STATUSES = new Set(["mastered", "exam-ready"]);
  const MISTAKE_TAGS = [
    ["algebra-error", "Algebra error"],
    ["chain-rule-setup", "Chain rule setup"],
    ["wrong-derivative-rule", "Wrong derivative rule"],
    ["units-mistake", "Units mistake"],
    ["related-rates-setup", "Related rates setup"],
    ["optimization-domain", "Optimization domain issue"],
    ["sign-error", "Sign error"],
    ["constant-of-integration", "Forgot + C"],
  ];

  const data = window.COURSE_MAP;
  const app = document.getElementById("app");
  const searchInput = document.getElementById("search-input");
  const searchOverlay = document.getElementById("search-overlay");
  const authShell = document.getElementById("auth-shell");
  const authModal = document.getElementById("auth-modal");
  const moduleNav = document.getElementById("module-nav");
  const progressCount = document.getElementById("progress-count");
  const progressMeta = document.getElementById("progress-meta");
  const progressBar = document.getElementById("progress-bar");
  const supabaseConfig = window.CALC_SUPABASE_CONFIG || {};
  const supabaseClient =
    window.supabase && supabaseConfig.url && supabaseConfig.publishableKey
      ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
          auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true,
          },
        })
      : null;

  if (!data) {
    app.innerHTML = "<section class=\"empty\"><h1>Course data is missing.</h1></section>";
    return;
  }

  const modules = data.modules || [];
  const lessons = modules.flatMap((module) =>
    module.parts.flatMap((part) => part.lessons.map((lesson) => ({ ...lesson, module, part })))
  );
  const lessonsById = new Map(lessons.map((lesson) => [lesson.id, lesson]));

  let progress = readStore(STORAGE_PROGRESS);
  let youtubeLinks = readStore(STORAGE_YOUTUBE);
  let lessonNotes = readStore(STORAGE_NOTES);
  let uiState = normalizeUiState({
    collapsedParts: {},
    searchFilter: "all",
    diagnosticAnswers: {},
    stuckLessons: {},
    examMode: {
      timers: {},
      attempted: {},
      confidence: {},
      flagged: {},
      notes: {},
    },
    ...readStore(STORAGE_UI),
  });
  let searchQuery = "";
  let searchOpen = false;
  let externalResources = [];
  let diagnosticData = null;
  let currentUser = null;
  let cloudStatus = supabaseClient ? "signed-out" : "offline";
  let cloudMessage = supabaseClient ? "Sign in to sync" : "Supabase client unavailable";
  let syncTimer = null;
  let hydratingCloudState = false;

  function readStore(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}");
    } catch (_error) {
      return {};
    }
  }

  function writeStore(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    if (SYNCED_STORAGE_KEYS.has(key)) scheduleCloudSync();
  }

  function normalizeUiState(value) {
    const source = value || {};
    return {
      ...source,
      collapsedParts: source.collapsedParts || {},
      searchFilter: source.searchFilter || "all",
      diagnosticAnswers: source.diagnosticAnswers || {},
      stuckLessons: source.stuckLessons || {},
      examMode: {
        timers: {},
        attempted: {},
        confidence: {},
        flagged: {},
        notes: {},
        ...(source.examMode || {}),
        timers: (source.examMode || {}).timers || {},
        attempted: (source.examMode || {}).attempted || {},
        confidence: (source.examMode || {}).confidence || {},
        flagged: (source.examMode || {}).flagged || {},
        notes: (source.examMode || {}).notes || {},
      },
    };
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#039;");
  }

  function courseStateSnapshot() {
    return {
      progress,
      youtube_links: youtubeLinks,
      lesson_notes: lessonNotes,
      ui_state: uiState,
    };
  }

  function setCloudStatus(status, message) {
    cloudStatus = status;
    cloudMessage = message;
    renderAuthShell();
  }

  function scheduleCloudSync() {
    if (hydratingCloudState || !currentUser || !supabaseClient) return;
    window.clearTimeout(syncTimer);
    setCloudStatus("syncing", "Saving...");
    syncTimer = window.setTimeout(() => {
      saveCloudState();
    }, 650);
  }

  async function saveCloudState() {
    if (!currentUser || !supabaseClient) return;
    window.clearTimeout(syncTimer);
    setCloudStatus("syncing", "Saving...");

    const { error } = await supabaseClient.from(SUPABASE_TABLE).upsert(
      {
        user_id: currentUser.id,
        ...courseStateSnapshot(),
      },
      { onConflict: "user_id" }
    );

    if (error) {
      setCloudStatus("error", "Sync setup needed");
      console.error("Supabase sync failed:", error);
      return;
    }

    setCloudStatus("synced", "Saved to Supabase");
  }

  async function loadCloudState() {
    if (!currentUser || !supabaseClient) return;
    setCloudStatus("syncing", "Loading save...");

    const { data: row, error } = await supabaseClient
      .from(SUPABASE_TABLE)
      .select("progress,youtube_links,lesson_notes,ui_state,updated_at")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (error) {
      setCloudStatus("error", "Run Supabase setup SQL");
      console.error("Supabase load failed:", error);
      return;
    }

    if (row) {
      applyCloudState(row);
      render();
      setCloudStatus("synced", "Loaded cloud save");
      saveCloudState();
      return;
    }

    setCloudStatus("syncing", "Creating cloud save...");
    await saveCloudState();
  }

  function applyCloudState(row) {
    const mergedUi = normalizeUiState({
      collapsedParts: {},
      searchFilter: "all",
      ...(row.ui_state || {}),
      ...uiState,
      collapsedParts: {
        ...((row.ui_state || {}).collapsedParts || {}),
        ...(uiState.collapsedParts || {}),
      },
      diagnosticAnswers: {
        ...((row.ui_state || {}).diagnosticAnswers || {}),
        ...(uiState.diagnosticAnswers || {}),
      },
      stuckLessons: {
        ...((row.ui_state || {}).stuckLessons || {}),
        ...(uiState.stuckLessons || {}),
      },
      examMode: {
        ...((row.ui_state || {}).examMode || {}),
        ...(uiState.examMode || {}),
      },
    });

    hydratingCloudState = true;
    progress = { ...(row.progress || {}), ...progress };
    youtubeLinks = { ...(row.youtube_links || {}), ...youtubeLinks };
    lessonNotes = { ...(row.lesson_notes || {}), ...lessonNotes };
    uiState = mergedUi;
    writeStore(STORAGE_PROGRESS, progress);
    writeStore(STORAGE_YOUTUBE, youtubeLinks);
    writeStore(STORAGE_NOTES, lessonNotes);
    writeStore(STORAGE_UI, uiState);
    hydratingCloudState = false;
  }

  function renderAuthShell() {
    if (!authShell) return;

    if (!supabaseClient) {
      authShell.innerHTML = "<span class=\"sync-chip offline\">Local only</span>";
      return;
    }

    if (!currentUser) {
      authShell.innerHTML = `
        <button class="button primary" type="button" data-open-auth>Sign In</button>
      `;
      return;
    }

    const email = currentUser.email || "Signed in";
    authShell.innerHTML = `
      <span class="sync-chip ${escapeHtml(cloudStatus)}" title="${escapeHtml(cloudMessage)}">
        <b></b>
        <span>${escapeHtml(shortEmail(email))}</span>
      </span>
      <button class="button compact" type="button" data-sync-now>Sync</button>
      <button class="button compact" type="button" data-sign-out>Sign Out</button>
    `;
  }

  function shortEmail(email) {
    if (email.length <= 22) return email;
    const [name, domain] = email.split("@");
    if (!domain) return `${email.slice(0, 19)}...`;
    return `${name.slice(0, 9)}...@${domain}`;
  }

  function openAuthModal(message = "") {
    if (!authModal) return;
    authModal.hidden = false;
    authModal.innerHTML = `
      <div class="auth-backdrop" data-close-auth></div>
      <article class="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button class="auth-close" type="button" data-close-auth aria-label="Close sign in">Close</button>
        <span class="label">Cloud Sync</span>
        <h2 id="auth-title">Save your calculus dashboard</h2>
        <p>Sign in to sync progress, lesson notes, YouTube overrides, and UI preferences across browsers.</p>
        <form class="auth-form" data-auth-form>
          <label>
            <span>Email</span>
            <input name="email" type="email" autocomplete="email" required>
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" minlength="6" required>
          </label>
          <div class="action-row">
            <button class="button primary" type="button" data-auth-action="sign-in">Sign In</button>
            <button class="button" type="button" data-auth-action="sign-up">Create Account</button>
          </div>
        </form>
        <p class="auth-note ${message ? "active" : ""}" data-auth-message>${escapeHtml(message)}</p>
        <p class="quiet">Use the publishable key only in this frontend. Never put a Supabase secret key in browser code.</p>
      </article>
    `;
    authModal.querySelector("input[name='email']")?.focus();
  }

  function closeAuthModal() {
    if (!authModal) return;
    authModal.hidden = true;
    authModal.innerHTML = "";
  }

  function setAuthMessage(message) {
    const node = authModal?.querySelector("[data-auth-message]");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("active", Boolean(message));
  }

  async function handleAuthAction(action) {
    if (!supabaseClient) return;
    const form = authModal?.querySelector("[data-auth-form]");
    if (!(form instanceof HTMLFormElement)) return;

    const formData = new FormData(form);
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    if (!email || password.length < 6) {
      setAuthMessage("Use an email and a password with at least 6 characters.");
      return;
    }

    setAuthMessage(action === "sign-up" ? "Creating account..." : "Signing in...");
    const authCall =
      action === "sign-up"
        ? supabaseClient.auth.signUp({ email, password })
        : supabaseClient.auth.signInWithPassword({ email, password });
    const { data: authData, error } = await authCall;

    if (error) {
      setAuthMessage(error.message);
      return;
    }

    if (authData.session) {
      currentUser = authData.user;
      closeAuthModal();
      renderAuthShell();
      await loadCloudState();
      return;
    }

    setAuthMessage("Account created. Check your email if confirmation is enabled, then sign in.");
  }

  async function signOut() {
    if (!supabaseClient) return;
    await saveCloudState();
    const { error } = await supabaseClient.auth.signOut({ scope: "local" });
    if (error) {
      setCloudStatus("error", error.message);
      return;
    }
    currentUser = null;
    setCloudStatus("signed-out", "Local only");
  }

  async function initSupabaseAuth() {
    renderAuthShell();
    if (!supabaseClient) return;

    const { data: sessionData, error } = await supabaseClient.auth.getSession();
    if (error) {
      setCloudStatus("error", error.message);
      return;
    }

    currentUser = sessionData.session?.user || null;
    renderAuthShell();
    if (currentUser) await loadCloudState();

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      currentUser = session?.user || null;
      renderAuthShell();
      if (currentUser) loadCloudState();
    });
  }

  async function loadSupplementalData() {
    const [resources, diagnostic] = await Promise.all([
      fetchJson("data/external-resources.json", []),
      fetchJson("data/diagnostic-precalc.json", null),
    ]);
    externalResources = Array.isArray(resources) ? resources : [];
    diagnosticData = diagnostic;
    render();
  }

  async function fetchJson(url, fallback) {
    try {
      const response = await fetch(url);
      if (!response.ok) return fallback;
      return await response.json();
    } catch (_error) {
      return fallback;
    }
  }

  function route() {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean).map(decodeURIComponent);
    if (!parts.length) return { name: "home" };
    if (parts[0] === "module") return { name: "module", id: parts.slice(1).join("/") };
    if (parts[0] === "lesson") return { name: "lesson", id: parts.slice(1).join("/") };
    if (parts[0] === "plan") return { name: "plan" };
    if (parts[0] === "diagnostic") return { name: "diagnostic" };
    if (parts[0] === "exam-mode") return { name: "exam-mode" };
    if (parts[0] === "notebook") return { name: "notebook" };
    return { name: "home" };
  }

  function href(kind, id) {
    return `#/${kind}/${encodeURIComponent(id)}`;
  }

  function moduleHref(id) {
    return href("module", id);
  }

  function lessonHref(id) {
    return href("lesson", id);
  }

  function todayIso(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  function defaultLessonState(lessonId) {
    return {
      lessonId,
      status: "not-started",
      confidence: 0,
      mistakes: [],
      lastStudiedAt: "",
      nextReviewAt: "",
      examReady: false,
    };
  }

  function lessonState(lesson) {
    const raw = progress[lesson.id];
    if (raw === true) {
      return {
        ...defaultLessonState(lesson.id),
        status: "mastered",
        confidence: 4,
        examReady: true,
      };
    }
    if (raw && typeof raw === "object") {
      const state = { ...defaultLessonState(lesson.id), ...raw };
      state.mistakes = Array.isArray(state.mistakes) ? state.mistakes : [];
      state.confidence = Number(state.confidence || 0);
      state.examReady = state.status === "exam-ready" || Boolean(state.examReady);
      return state;
    }
    return defaultLessonState(lesson.id);
  }

  function updateLessonState(lessonId, updates) {
    const lesson = lessonsById.get(lessonId);
    if (!lesson) return;
    const current = lessonState(lesson);
    const next = { ...current, ...updates };
    if (updates.status) {
      next.lastStudiedAt = todayIso();
      next.examReady = updates.status === "exam-ready";
      next.nextReviewAt = reviewDateFor(next.status, next.confidence);
    }
    progress[lessonId] = next;
    writeStore(STORAGE_PROGRESS, progress);
  }

  function reviewDateFor(status, confidence) {
    if (status === "exam-ready") return todayIso(14);
    if (status === "mastered") return todayIso(7);
    if (status === "reviewed") return todayIso(4);
    if (status === "practiced") return todayIso(Math.max(2, 5 - Number(confidence || 0)));
    if (status === "got-stuck") return todayIso(1);
    if (status === "watched") return todayIso(2);
    return "";
  }

  function isLessonComplete(lesson) {
    return COMPLETE_STATUSES.has(lessonState(lesson).status);
  }

  function isLessonStarted(lesson) {
    return lessonState(lesson).status !== "not-started";
  }

  function completeItems(items = lessons) {
    return items.filter(isLessonComplete).length;
  }

  function percent(done, total) {
    return total ? Math.round((done / total) * 100) : 0;
  }

  function nextLesson(items = lessons) {
    return items.find((lesson) => !isLessonComplete(lesson)) || items[0] || null;
  }

  function lessonPosition(lesson) {
    const index = lessons.findIndex((item) => item.id === lesson.id);
    return index < 0 ? "" : `${index + 1} of ${lessons.length}`;
  }

  function cleanTitle(title) {
    return String(title || "")
      .replace(/^Session\s+\d+:\s*/i, "")
      .replace(/^Problem Set\s+/i, "Problem Set ");
  }

  function shortModuleTitle(module) {
    return module.title.replace(/^\d+\.\s*/, "");
  }

  function allResources(lesson) {
    return Object.values(lesson.resources || {}).flat().filter(Boolean);
  }

  function resourceHref(resource) {
    return resource.filePath || resource.youtubeUrl || resource.archiveUrl || resource.resourcePage || "#";
  }

  function resourceLink(resource, label, tone = "") {
    if (!resource) return "";
    return `<a class="button ${tone}" href="${escapeHtml(resourceHref(resource))}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }

  function firstResource(resources, label, tone = "") {
    if (!resources || !resources.length) return "";
    const suffix = resources.length > 1 ? ` (${resources.length})` : "";
    return resourceLink(resources[0], `${label}${suffix}`, tone);
  }

  function quickActions(lesson) {
    const resources = lesson.resources || {};
    return [
      firstResource(resources.notes, "Notes", "blue"),
      firstResource(resources.problems, "Practice", "amber"),
      firstResource(resources.solutions, "Solutions", "red"),
      firstResource(resources.exams, "Exam", "amber"),
      firstResource(resources.examSolutions, "Exam Solution", "red"),
    ]
      .filter(Boolean)
      .join("");
  }

  function updateProgress() {
    const done = completeItems();
    const total = lessons.length;
    const amount = percent(done, total);
    progressCount.textContent = `${amount}%`;
    progressMeta.textContent = `${done} of ${total} complete`;
    progressBar.style.width = `${amount}%`;
  }

  function renderNav() {
    const current = route();
    moduleNav.innerHTML = modules
      .map((module, index) => {
        const moduleLessons = module.parts.flatMap((part) => part.lessons);
        const done = completeItems(moduleLessons);
        const active = current.id === module.id ? "active" : "";
        return `
          <a class="${active}" href="${moduleHref(module.id)}">
            <span>${index + 1}</span>
            <strong>${escapeHtml(shortModuleTitle(module))}</strong>
            <small>${done}/${moduleLessons.length}</small>
          </a>
        `;
      })
      .join("");
  }

  function currentWeek() {
    return (
      data.weeklyPlan.find((week) => {
        const refs = weekLessons(week);
        return refs.length && completeItems(refs) < refs.length;
      }) ||
      data.weeklyPlan[0] || { week: "Week 0", title: "Pre-calculus review", lessonRefs: [] }
    );
  }

  function weekLessons(week) {
    return (week.lessonRefs || []).map((id) => lessonsById.get(id)).filter(Boolean);
  }

  function renderHome() {
    const next = nextLesson();
    const week = currentWeek();
    const refs = weekLessons(week);
    const weekDone = completeItems(refs);
    const image = data.course.imagePath
      ? `<img src="${escapeHtml(data.course.imagePath)}" alt="Calculus graph from the source course">`
      : "";

    app.innerHTML = `
      <section class="today-layout page-enter">
        <article class="continue-card">
          <div class="continue-copy">
            <span class="label">Today Focus</span>
            <h1>${next ? escapeHtml(cleanTitle(next.lessonTitle)) : "Course Complete"}</h1>
            <p>${next ? escapeHtml(`${next.module.title} / ${next.part.title}`) : "Everything tracked is complete."}</p>
            <div class="hero-metrics">
              <span>${next ? escapeHtml(lessonPosition(next)) : "Done"}</span>
              <span>${escapeHtml(week.week)}</span>
              <span>${refs.length ? `${weekDone}/${refs.length} this week` : "Warmup"}</span>
            </div>
            <div class="action-row">
              ${next ? `<a class="button primary xl" href="${lessonHref(next.id)}">Continue Lesson</a>` : ""}
              ${courseIntroButton()}
              <a class="button xl" href="#/plan">Weekly Plan</a>
            </div>
          </div>
          <figure>${image}</figure>
        </article>

        <aside class="week-focus">
          <div>
            <span class="label">This Week</span>
            <h2>${escapeHtml(week.title)}</h2>
            <p>${refs.length ? `${weekDone} complete, ${refs.length - weekDone} remaining` : "Review algebra, functions, trigonometry, and logs."}</p>
          </div>
          <div class="week-timeline">
            ${refs.length ? refs.slice(0, 8).map(timelineLesson).join("") : warmupTimeline()}
          </div>
        </aside>
      </section>

      ${readinessBanner()}
      ${todayQueue(next)}

      <section class="stat-row page-enter">
        <article><strong>${data.counts.modules}</strong><span>Modules</span></article>
        <article><strong>${data.counts.lessons}</strong><span>Lessons and checkpoints</span></article>
        <article><strong>${data.counts.problemSets}</strong><span>Problem sets</span></article>
        <article><strong>${data.counts.examPrepLessons}</strong><span>Exam prep items</span></article>
      </section>

      <section class="section-block page-enter">
        <div class="section-title">
          <span class="label">Course Path</span>
          <h2>Move through the course</h2>
        </div>
        <div class="module-grid">
          ${modules.map(moduleCard).join("")}
        </div>
      </section>

      <section class="section-block page-enter">
        <div class="section-title">
          <span class="label">Engineering sequence</span>
          <h2>Concept arc</h2>
        </div>
        <div class="path-strip">
          ${data.studyPath.map(pathStep).join("")}
        </div>
      </section>
    `;
  }

  function readinessBanner() {
    if (!diagnosticData) return "";
    const summary = diagnosticSummary();
    const complete = summary.answered === diagnosticData.questions.length;
    return `
      <section class="readiness-banner page-enter">
        <div>
          <span class="label">Before Session 1</span>
          <h2>${complete ? `Readiness score: ${summary.correct}/${summary.total}` : "Take the 20-question readiness check"}</h2>
          <p>${complete ? diagnosticMessage(summary) : "Spot weak algebra, trig, logs, functions, and graph skills before MIT starts moving quickly."}</p>
        </div>
        <a class="button primary xl" href="#/diagnostic">${complete ? "Review Diagnostic" : "Start Check"}</a>
      </section>
    `;
  }

  function todayQueue(next) {
    const weak = weakestLesson();
    const mistake = topMistake();
    return `
      <section class="today-queue page-enter">
        <article>
          <span>1</span>
          <h3>Continue next lesson</h3>
          <p>${next ? escapeHtml(cleanTitle(next.lessonTitle)) : "Everything is complete."}</p>
          ${next ? `<a class="button primary compact" href="${lessonHref(next.id)}">Continue</a>` : ""}
        </article>
        <article>
          <span>2</span>
          <h3>Review weakest topic</h3>
          <p>${weak ? escapeHtml(`${cleanTitle(weak.lessonTitle)} (${lessonState(weak).confidence || 0}/5)`) : "No weak topic tagged yet."}</p>
          ${weak ? `<a class="button compact" href="${lessonHref(weak.id)}">Review</a>` : `<a class="button compact" href="#/diagnostic">Diagnose</a>`}
        </article>
        <article>
          <span>3</span>
          <h3>Do 5 mixed drills</h3>
          <p>${mistake ? `Focus: ${escapeHtml(labelForMistake(mistake.tag))}` : "Start with algebra, functions, and limits."}</p>
          <a class="button compact" href="${escapeHtml(resourceUrlForTopic("review", "practice-drills") || "https://tutorial.math.lamar.edu/classes/calci/calci.aspx")}" target="_blank" rel="noopener">Open Drills</a>
        </article>
        <article>
          <span>4</span>
          <h3>One exam-style problem</h3>
          <p>Use MIT exam PDFs with solutions hidden until after an attempt.</p>
          <a class="button compact" href="#/exam-mode">Exam Mode</a>
        </article>
      </section>
    `;
  }

  function courseIntroButton() {
    const intro = data.course.introVideos?.[0];
    if (!intro) return "";
    return `<a class="button blue xl" href="${escapeHtml(intro.watchUrl || intro.url)}" target="_blank" rel="noopener">Course Intro</a>`;
  }

  function diagnosticSummary() {
    const questions = diagnosticData?.questions || [];
    const answers = uiState.diagnosticAnswers || {};
    const weakTopics = {};
    let correct = 0;
    let answered = 0;

    questions.forEach((question) => {
      const value = answers[question.id];
      if (value === undefined) return;
      answered += 1;
      if (Number(value) === question.answerIndex) {
        correct += 1;
      } else {
        weakTopics[question.topic] = (weakTopics[question.topic] || 0) + 1;
      }
    });

    return { correct, answered, total: questions.length, weakTopics };
  }

  function diagnosticMessage(summary) {
    const weak = Object.entries(summary.weakTopics).sort((a, b) => b[1] - a[1])[0];
    if (!weak) return "You are ready to start MIT Session 1.";
    return `Warm up ${humanTopic(weak[0])} before Session 1.`;
  }

  function weakestLesson() {
    return lessons
      .filter((lesson) => isLessonStarted(lesson) && !isLessonComplete(lesson))
      .sort((a, b) => {
        const aState = lessonState(a);
        const bState = lessonState(b);
        if (aState.status === "got-stuck" && bState.status !== "got-stuck") return -1;
        if (bState.status === "got-stuck" && aState.status !== "got-stuck") return 1;
        return aState.confidence - bState.confidence;
      })[0];
  }

  function topMistake() {
    const counts = {};
    lessons.forEach((lesson) => {
      lessonState(lesson).mistakes.forEach((tag) => {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? { tag: top[0], count: top[1] } : null;
  }

  function labelForMistake(tag) {
    return MISTAKE_TAGS.find((item) => item[0] === tag)?.[1] || humanTopic(tag);
  }

  function statusLabel(status) {
    return STATUS_FLOW.find((item) => item[0] === status)?.[1] || "Not started";
  }

  function statusOptions(selected) {
    return STATUS_FLOW.map(
      ([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`
    ).join("");
  }

  function humanTopic(value) {
    return String(value || "")
      .replaceAll("-", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function resourceUrlForTopic(topic, role) {
    const resource = externalResources.find((item) => item.role === role);
    if (!resource) return "";
    return resource.topicLinks?.[topic] || resource.url || "";
  }

  function timelineLesson(lesson, index) {
    const done = isLessonComplete(lesson) ? "done" : "";
    return `
      <a class="timeline-item ${done}" href="${lessonHref(lesson.id)}">
        <span>${index + 1}</span>
        <strong>${escapeHtml(cleanTitle(lesson.lessonTitle))}</strong>
      </a>
    `;
  }

  function warmupTimeline() {
    return ["Algebra", "Functions", "Trigonometry", "Logarithms"]
      .map((item, index) => `<span class="timeline-item"><span>${index + 1}</span><strong>${item}</strong></span>`)
      .join("");
  }

  function moduleCard(module) {
    const moduleLessons = module.parts.flatMap((part) => part.lessons);
    const done = completeItems(moduleLessons);
    const next = nextLesson(moduleLessons);
    const amount = percent(done, moduleLessons.length);
    return `
      <a class="module-card" href="${moduleHref(module.id)}">
        <div class="module-ring" style="--amount:${amount}">
          <span>${amount}%</span>
        </div>
        <div>
          <span class="label">${escapeHtml(module.topic)}</span>
          <h3>${escapeHtml(module.title)}</h3>
          <p>${next ? `Next: ${escapeHtml(cleanTitle(next.lessonTitle))}` : "Complete"}</p>
        </div>
        <div class="mini-progress">
          <span>${done}/${moduleLessons.length}</span>
          <div><i style="width:${amount}%"></i></div>
        </div>
      </a>
    `;
  }

  function pathStep(path, index) {
    const count = path.lessonRefs ? path.lessonRefs.length : 0;
    return `
      <article class="path-step">
        <span>${index + 1}</span>
        <h3>${escapeHtml(path.title)}</h3>
        <p>${count ? `${count} linked items` : "Warmup"}</p>
      </article>
    `;
  }

  function renderModule(id) {
    const module = modules.find((item) => item.id === id);
    if (!module) return renderHome();

    const moduleLessons = module.parts.flatMap((part) => part.lessons);
    const done = completeItems(moduleLessons);
    const next = nextLesson(moduleLessons);
    const amount = percent(done, moduleLessons.length);
    const examLinks = (module.examLinks || [])
      .map((resource) =>
        resourceLink(
          resource,
          resource.title.replace(/\.pdf$/i, ""),
          resource.learningResourceTypes?.includes("Exam Solutions") ? "red" : "amber"
        )
      )
      .join("");

    app.innerHTML = `
      <section class="module-summary page-enter">
        <div>
          <a class="back-link" href="#/">Home</a>
          <span class="label">${escapeHtml(module.topic)}</span>
          <h1>${escapeHtml(module.title)}</h1>
          <p>${done} of ${moduleLessons.length} complete</p>
        </div>
        <div class="summary-actions">
          <div class="module-ring large" style="--amount:${amount}"><span>${amount}%</span></div>
          ${next ? `<a class="button primary xl" href="${lessonHref(next.id)}">Continue Module</a>` : ""}
          ${examLinks}
        </div>
      </section>

      <section class="module-flow page-enter">
        ${module.parts.map(partSection).join("")}
      </section>
    `;
  }

  function partSection(part) {
    const collapsed = Boolean(uiState.collapsedParts[part.id]);
    return `
      <article class="part-section ${collapsed ? "collapsed" : ""}">
        <button class="part-toggle" type="button" data-toggle-part="${escapeHtml(part.id)}" aria-expanded="${!collapsed}">
          <span>
            <strong>${escapeHtml(part.title)}</strong>
            <small>${completeItems(part.lessons)}/${part.lessons.length} complete</small>
          </span>
          <b>${collapsed ? "+" : "-"}</b>
        </button>
        <div class="part-body">
          <div class="lesson-stack">
            ${part.lessons.map(lessonRow).join("")}
          </div>
        </div>
      </article>
    `;
  }

  function lessonRow(lesson) {
    const state = lessonState(lesson);
    const complete = isLessonComplete(lesson);
    const resources = allResources(lesson);
    return `
      <article class="lesson-row ${complete ? "complete" : ""}">
        <span class="lesson-status-dot ${escapeHtml(state.status)}" aria-label="${escapeHtml(statusLabel(state.status))}"></span>
        <a class="lesson-main" href="${lessonHref(lesson.id)}">
          <strong>${escapeHtml(cleanTitle(lesson.lessonTitle))}</strong>
          <span>${escapeHtml(lesson.sessionNumber ? `Session ${lesson.sessionNumber}` : lesson.lessonType)} / ${escapeHtml(lesson.topic)} / ${escapeHtml(statusLabel(state.status))}</span>
        </a>
        <select class="status-select compact" data-status-id="${escapeHtml(lesson.id)}" aria-label="Lesson status">
          ${statusOptions(state.status)}
        </select>
        <a class="button primary compact" href="${lessonHref(lesson.id)}">Study</a>
        <details class="lesson-resources">
          <summary>${resources.length} resources</summary>
          <div>${resourceButtonsForLesson(lesson)}</div>
        </details>
      </article>
    `;
  }

  function resourceButtonsForLesson(lesson) {
    const resources = lesson.resources || {};
    return [
      firstResource(resources.notes, "Notes", "blue"),
      firstResource(resources.problems, "Practice", "amber"),
      firstResource(resources.solutions, "Solutions", "red"),
      firstResource(resources.exams, "Exam", "amber"),
      firstResource(resources.examSolutions, "Exam Solution", "red"),
      `<a class="button" href="${escapeHtml(lesson.sourcePagePath)}" target="_blank" rel="noopener">OCW Page</a>`,
    ]
      .filter(Boolean)
      .join("");
  }

  function renderLesson(id) {
    const lesson = lessonsById.get(id);
    if (!lesson) return renderHome();

    const index = lessons.findIndex((item) => item.id === lesson.id);
    const previous = lessons[index - 1];
    const next = lessons[index + 1];
    const state = lessonState(lesson);
    const savedVideo = youtubeLinks[lesson.id] || lessonDefaultVideoUrl(lesson);
    const note = lessonNotes[lesson.id] || "";

    app.innerHTML = `
      <section class="lesson-hero page-enter">
        <div>
          <a class="back-link" href="${moduleHref(lesson.module.id)}">Back to ${escapeHtml(lesson.module.title)}</a>
          <span class="label">${escapeHtml(lessonPosition(lesson))}</span>
          <h1>${escapeHtml(cleanTitle(lesson.lessonTitle))}</h1>
          <p>${escapeHtml(lesson.part.title)}</p>
        </div>
        <div class="lesson-nav-actions">
          ${previous ? `<a class="button" href="${lessonHref(previous.id)}">Previous</a>` : ""}
          ${next ? `<a class="button primary" href="${lessonHref(next.id)}">Next Lesson</a>` : ""}
          ${masteryMiniControl(lesson, state)}
        </div>
      </section>

      <section class="guided-studio page-enter">
        ${watchPanel(lesson, savedVideo)}
        ${understandPanel(lesson)}
        ${resourcePanel("Read", "Lecture notes", lesson.resources.notes, "blue")}
        ${resourcePanel("Practice", "Problems", (lesson.resources.problems || []).concat(lesson.resources.exams || []), "amber")}
        ${resourcePanel("Check", "Solutions", (lesson.resources.solutions || []).concat(lesson.resources.examSolutions || []), "red")}
        ${helpPanel(lesson)}
      </section>

      <section class="mastery-panel page-enter">
        ${masteryPanel(lesson, state)}
      </section>

      <section class="reflection-panel page-enter">
        <div>
          <span class="label">Reflection</span>
          <h2>What clicked? What needs another pass?</h2>
        </div>
        <textarea data-note-input="${escapeHtml(lesson.id)}" placeholder="Write a quick study note. It saves locally in this browser.">${escapeHtml(note)}</textarea>
      </section>

      ${detectedVideos(lesson.resources.videos)}
    `;
  }

  function masteryMiniControl(lesson, state) {
    return `
      <label class="status-pill">
        <span>Status</span>
        <select class="status-select" data-status-id="${escapeHtml(lesson.id)}">
          ${statusOptions(state.status)}
        </select>
      </label>
    `;
  }

  function understandPanel(lesson) {
    const open = Boolean(uiState.stuckLessons?.[lesson.id]);
    return `
      <article class="studio-card understand-card">
        <span class="label">Understand</span>
        <h2>Stuck Mode</h2>
        <p class="quiet">Use hints in order. The goal is to find the first move before opening the solution.</p>
        <button class="button ${open ? "primary" : ""}" type="button" data-toggle-stuck="${escapeHtml(lesson.id)}">I'm stuck</button>
        ${open ? hintLadder(lesson) : ""}
      </article>
    `;
  }

  function hintLadder(lesson) {
    return `
      <ol class="hint-ladder">
        ${hintsForLesson(lesson).map((hint) => `<li>${escapeHtml(hint)}</li>`).join("")}
      </ol>
    `;
  }

  function hintsForLesson(lesson) {
    const topic = lessonTopicKey(lesson);
    const ladders = {
      limits: [
        "Identify what x is approaching.",
        "Try direct substitution first.",
        "If substitution fails, simplify algebraically.",
        "Look for factoring, conjugates, or known trig limits.",
        "Only then open the solution and compare the first move.",
      ],
      derivatives: [
        "Name the outside operation and the inside expression.",
        "Choose the rule: power, product, quotient, chain, or implicit.",
        "Differentiate one layer at a time.",
        "Simplify only after the derivative is structurally correct.",
        "Check the solution for rule choice, not just final algebra.",
      ],
      "chain-rule": [
        "Circle the inner function.",
        "Differentiate the outer function while leaving the inside alone.",
        "Multiply by the derivative of the inside.",
        "Repeat if there is another nested layer.",
        "Compare your setup to the solution before simplifying.",
      ],
      "related-rates": [
        "Draw the situation.",
        "Write an equation connecting the changing quantities.",
        "Differentiate both sides with respect to time.",
        "Substitute known values after differentiating.",
        "Solve for the missing rate and check units.",
      ],
      optimization: [
        "Define the quantity you are maximizing or minimizing.",
        "Write constraints and reduce to one variable.",
        "Differentiate the objective function.",
        "Check critical points and endpoints.",
        "State the answer in the original context.",
      ],
      integrals: [
        "Decide whether this is area, accumulation, or antiderivative.",
        "Look for a basic rule or a substitution pattern.",
        "If substituting, compute du before rewriting.",
        "Track bounds carefully for definite integrals.",
        "Differentiate your antiderivative to check it.",
      ],
      series: [
        "Identify the series type or power series center.",
        "Check convergence before manipulating terms.",
        "Choose a test: geometric, ratio, comparison, or alternating.",
        "For Taylor series, match derivatives at the center.",
        "Write the interval of convergence when needed.",
      ],
    };
    return ladders[topic] || [
      "Restate the goal in one sentence.",
      "List the known quantities and formulas that may apply.",
      "Make the first algebraic or calculus move only.",
      "Try a smaller similar example.",
      "Open the solution and compare the strategy.",
    ];
  }

  function helpPanel(lesson) {
    const resources = resourceStackForLesson(lesson);
    return `
      <article class="studio-card help-card">
        <span class="label">Need help?</span>
        <h2>Resource stack</h2>
        ${
          resources.length
            ? `<div class="resource-list">${resources.map(helpResourceItem).join("")}</div>`
            : "<p class=\"quiet\">Run through the MIT notes first. External resource matching loads when served locally.</p>"
        }
      </article>
    `;
  }

  function helpResourceItem(resource) {
    return `
      <a class="resource-item" href="${escapeHtml(resource.url)}" target="_blank" rel="noopener">
        <span>${escapeHtml(resource.label)}<small>${escapeHtml(resource.source)}</small></span>
        <b class="${escapeHtml(resource.tone)}">Open</b>
      </a>
    `;
  }

  function resourceStackForLesson(lesson) {
    const topic = lessonTopicKey(lesson);
    const roleLabels = {
      textbook: ["Textbook explanation", "blue"],
      "basic-rescue": ["Easier explanation", "amber"],
      "long-lecture": ["Long lecture", "red"],
      "practice-drills": ["Practice drills", "amber"],
      "interactive-practice": ["Interactive check", "blue"],
      "visual-intuition": ["Visual intuition", "blue"],
    };

    return externalResources
      .filter((resource) => roleLabels[resource.role])
      .map((resource) => {
        const url = resource.topicLinks?.[topic] || matchingTopicUrl(resource, topic);
        if (!url) return null;
        const [label, tone] = roleLabels[resource.role];
        return { label, tone, source: resource.source, url };
      })
      .filter(Boolean)
      .slice(0, 6);
  }

  function matchingTopicUrl(resource, topic) {
    if (resource.topicTags?.includes(topic)) return resource.url;
    if (topic === "chain-rule" && resource.topicTags?.includes("derivatives")) return resource.url;
    if (topic === "related-rates" && resource.topicTags?.includes("applications-of-derivatives")) return resource.url;
    if (topic === "optimization" && resource.topicTags?.includes("applications-of-derivatives")) return resource.url;
    if (topic === "integration-techniques" && resource.topicTags?.includes("integrals")) return resource.url;
    return "";
  }

  function lessonTopicKey(lesson) {
    const text = `${lesson.lessonTitle} ${lesson.topic} ${lesson.partTitle || ""} ${lesson.moduleTitle || ""}`.toLowerCase();
    if (text.includes("chain rule")) return "chain-rule";
    if (text.includes("related rates")) return "related-rates";
    if (text.includes("optimization") || text.includes("max-min") || text.includes("linear approximation")) return "optimization";
    if (text.includes("taylor") || text.includes("series")) return "series";
    if (text.includes("limit") || text.includes("continuity")) return "limits";
    if (text.includes("integral") || text.includes("antiderivative") || text.includes("fundamental theorem")) return "integrals";
    if (text.includes("techniques") || text.includes("substitution") || text.includes("partial fractions") || text.includes("trig substitution")) return "integration-techniques";
    if (text.includes("derivative") || text.includes("differentiation")) return "derivatives";
    return "review";
  }

  function masteryPanel(lesson, state) {
    return `
      <article>
        <div>
          <span class="label">Mastery engine</span>
          <h2>How solid is this lesson?</h2>
          <p>Status, confidence, mistake tags, and review dates sync with your account.</p>
        </div>
        <div class="mastery-controls">
          <label>
            <span>Status</span>
            <select class="status-select" data-status-id="${escapeHtml(lesson.id)}">
              ${statusOptions(state.status)}
            </select>
          </label>
          <label>
            <span>Confidence ${state.confidence}/5</span>
            <input type="range" min="0" max="5" value="${escapeHtml(state.confidence)}" data-confidence-id="${escapeHtml(lesson.id)}">
          </label>
          <div>
            <span>Mistake tags</span>
            <div class="mistake-tags">
              ${MISTAKE_TAGS.map(([tag, label]) => mistakeCheckbox(lesson, state, tag, label)).join("")}
            </div>
          </div>
          <div class="review-date">
            <strong>Next review</strong>
            <span>${state.nextReviewAt || "Set after status update"}</span>
          </div>
        </div>
      </article>
    `;
  }

  function mistakeCheckbox(lesson, state, tag, label) {
    const checked = state.mistakes.includes(tag) ? "checked" : "";
    return `
      <label>
        <input type="checkbox" ${checked} data-mistake-id="${escapeHtml(lesson.id)}" data-mistake-tag="${escapeHtml(tag)}">
        <span>${escapeHtml(label)}</span>
      </label>
    `;
  }

  function watchPanel(lesson, savedVideo) {
    const videoSequence = lessonVideoSequence(lesson);
    const embedUrl = youtubeEmbedUrl(savedVideo);
    return `
      <article class="studio-card watch-card">
        <span class="label">Watch</span>
        <h2>Lesson video sequence</h2>
        ${
          embedUrl
            ? `<div class="video-frame"><iframe src="${escapeHtml(embedUrl)}" title="Saved lesson video" allowfullscreen></iframe></div>`
            : `<div class="video-placeholder"><strong>Video link needed</strong><span>Add or choose a YouTube lesson clip.</span></div>`
        }
        ${
          videoSequence.length
            ? `<div class="clip-list" aria-label="Video sequence">${videoSequence.map((video) => videoClipButton(lesson, video, savedVideo)).join("")}</div>`
            : ""
        }
        <input class="youtube-input" data-youtube-input="${escapeHtml(lesson.id)}" type="url" value="${escapeHtml(savedVideo)}" placeholder="https://www.youtube.com/watch?v=...">
        <div class="action-row">
          <button class="button primary" type="button" data-save-youtube="${escapeHtml(lesson.id)}">Save Link</button>
          <button class="button" type="button" data-open-youtube="${escapeHtml(lesson.id)}">Open Video</button>
        </div>
      </article>
    `;
  }

  function lessonVideoSequence(lesson) {
    const defaults = lesson.youtube?.defaultVideos || [];
    if (defaults.length) return defaults.map(normalizeVideo).filter((video) => video.url);

    return (lesson.resources.videos || [])
      .map((video, index) =>
        normalizeVideo({
          order: index + 1,
          title: video.title,
          url: video.youtubeUrl || video.archiveUrl || video.resourcePage,
          embedUrl: video.youtubeUrl,
          watchUrl: video.youtubeUrl || video.archiveUrl || video.resourcePage,
          youtubeKey: video.youtubeKey,
        })
      )
      .filter((video) => video.url);
  }

  function normalizeVideo(video, index = 0) {
    const url = video.url || video.embedUrl || video.watchUrl || "";
    return {
      order: video.order || index + 1,
      title: video.title || `Clip ${video.order || index + 1}`,
      url,
      embedUrl: video.embedUrl || url,
      watchUrl: video.watchUrl || url,
      youtubeKey: video.youtubeKey || "",
    };
  }

  function lessonDefaultVideoUrl(lesson) {
    return lesson.youtube?.defaultVideoUrl || lessonVideoSequence(lesson)[0]?.url || "";
  }

  function videoClipButton(lesson, video, savedVideo) {
    const active = [video.url, video.embedUrl, video.watchUrl].includes(savedVideo) ? "active" : "";
    return `
      <button class="${active}" type="button" data-use-ocw-video="${escapeHtml(lesson.id)}" data-video-url="${escapeHtml(video.url)}">
        <span>${escapeHtml(video.order)}</span>
        <strong>${escapeHtml(video.title)}</strong>
      </button>
    `;
  }

  function youtubeEmbedUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url.trim());
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      let key = "";

      if (host === "youtu.be") {
        key = parsed.pathname.split("/").filter(Boolean)[0] || "";
      } else if (host.includes("youtube.com") || host.includes("youtube-nocookie.com")) {
        if (parsed.pathname.includes("/embed/")) {
          key = parsed.pathname.split("/embed/")[1].split("/")[0] || "";
        } else {
          key = parsed.searchParams.get("v") || "";
        }
      }

      if (!key) return "";

      const params = new URLSearchParams();
      const start =
        normalizeSeconds(parsed.searchParams.get("start")) ||
        normalizeSeconds(parsed.searchParams.get("time_continue")) ||
        secondsFromTimestamp(parsed.searchParams.get("t"));
      const end = normalizeSeconds(parsed.searchParams.get("end"));
      if (start) params.set("start", start);
      if (end) params.set("end", end);

      const query = params.toString();
      return `https://www.youtube.com/embed/${encodeURIComponent(key)}${query ? `?${query}` : ""}`;
    } catch (_error) {
      return "";
    }
  }

  function normalizeSeconds(value) {
    if (!value) return "";
    const trimmed = String(value).trim();
    return /^\d+$/.test(trimmed) ? trimmed : "";
  }

  function secondsFromTimestamp(value) {
    if (!value) return "";
    const trimmed = String(value).trim().toLowerCase();
    if (/^\d+$/.test(trimmed)) return trimmed;

    const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (!match) return "";

    const total =
      Number(match[1] || 0) * 3600 +
      Number(match[2] || 0) * 60 +
      Number(match[3] || 0);
    return total ? String(total) : "";
  }

  function resourcePanel(label, title, resources, tone) {
    const items = resources || [];
    return `
      <article class="studio-card">
        <span class="label">${escapeHtml(label)}</span>
        <h2>${escapeHtml(title)}</h2>
        ${
          items.length
            ? `<div class="resource-list">${items.map((resource) => resourceItem(resource, tone)).join("")}</div>`
            : "<p class=\"quiet\">No linked PDF for this step.</p>"
        }
      </article>
    `;
  }

  function resourceItem(resource, tone) {
    return `
      <a class="resource-item" href="${escapeHtml(resourceHref(resource))}" target="_blank" rel="noopener">
        <span>${escapeHtml(resource.title || "Resource")}</span>
        <b class="${tone}">Open</b>
      </a>
    `;
  }

  function detectedVideos(videos) {
    if (!videos || !videos.length) return "";
    return `
      <section class="section-block page-enter">
        <div class="section-title">
          <span class="label">OCW video resources</span>
          <h2>Detected links</h2>
        </div>
        <div class="video-grid">
          ${videos
            .map(
              (video) => `
                <article class="video-card">
                  <h3>${escapeHtml(video.title)}</h3>
                  <div class="action-row">
                    ${video.youtubeUrl ? resourceLink(video, "YouTube", "blue") : ""}
                    ${video.archiveUrl ? `<a class="button" href="${escapeHtml(video.archiveUrl)}" target="_blank" rel="noopener">Archive</a>` : ""}
                  </div>
                </article>
              `
            )
            .join("")}
        </div>
      </section>
    `;
  }

  function renderPlan() {
    app.innerHTML = `
      <section class="page-hero page-enter">
        <div>
          <a class="back-link" href="#/">Home</a>
          <span class="label">Recommended pacing</span>
          <h1>Weekly Plan</h1>
          <p>Sixteen weeks from pre-calculus review to final exam prep.</p>
        </div>
      </section>
      <section class="week-list page-enter">
        ${data.weeklyPlan.map(weekRow).join("")}
      </section>
    `;
  }

  function renderDiagnostic() {
    const summary = diagnosticSummary();
    const weak = Object.entries(summary.weakTopics).sort((a, b) => b[1] - a[1]);
    app.innerHTML = `
      <section class="page-hero page-enter">
        <div>
          <a class="back-link" href="#/">Home</a>
          <span class="label">Pre-calculus review</span>
          <h1>${escapeHtml(diagnosticData?.title || "Readiness Check")}</h1>
          <p>${escapeHtml(diagnosticData?.description || "Run the local server to load the diagnostic questions.")}</p>
        </div>
        <div class="lesson-nav-actions">
          <a class="button" href="${escapeHtml(diagnosticData?.reviewResource?.url || "https://tutorial.math.lamar.edu/classes/calci/review.aspx")}" target="_blank" rel="noopener">Paul's Review</a>
        </div>
      </section>
      <section class="diagnostic-summary page-enter">
        <article><strong>${summary.correct}/${summary.total}</strong><span>Score</span></article>
        <article><strong>${summary.answered}</strong><span>Answered</span></article>
        <article><strong>${weak[0] ? humanTopic(weak[0][0]) : "None"}</strong><span>Weakest topic</span></article>
      </section>
      ${
        weak.length
          ? `<section class="weak-topic-list page-enter">
              <h2>Review before Session 1</h2>
              ${weak.map(([topic]) => diagnosticReviewLink(topic)).join("")}
            </section>`
          : ""
      }
      <section class="diagnostic-list page-enter">
        ${(diagnosticData?.questions || []).map(diagnosticQuestion).join("")}
      </section>
    `;
  }

  function diagnosticReviewLink(topic) {
    const question = (diagnosticData?.questions || []).find((item) => item.topic === topic);
    return `<a class="button amber" href="${escapeHtml(question?.reviewUrl || diagnosticData?.reviewResource?.url || "#")}" target="_blank" rel="noopener">${escapeHtml(humanTopic(topic))}</a>`;
  }

  function diagnosticQuestion(question, index) {
    const saved = uiState.diagnosticAnswers?.[question.id];
    const answered = saved !== undefined;
    const correct = answered && Number(saved) === question.answerIndex;
    return `
      <article class="diagnostic-question ${answered ? (correct ? "correct" : "missed") : ""}">
        <div>
          <span class="label">${index + 1} / ${escapeHtml(humanTopic(question.topic))}</span>
          <h3>${escapeHtml(question.prompt)}</h3>
        </div>
        <div class="diagnostic-choices">
          ${question.choices
            .map(
              (choice, choiceIndex) => `
                <label>
                  <input type="radio" name="${escapeHtml(question.id)}" value="${choiceIndex}" data-diagnostic-answer="${escapeHtml(question.id)}" ${Number(saved) === choiceIndex ? "checked" : ""}>
                  <span>${escapeHtml(choice)}</span>
                </label>
              `
            )
            .join("")}
        </div>
        ${answered && !correct ? `<a class="button compact amber" href="${escapeHtml(question.reviewUrl)}" target="_blank" rel="noopener">Review ${escapeHtml(humanTopic(question.topic))}</a>` : ""}
      </article>
    `;
  }

  function renderExamMode() {
    const exams = examItems();
    app.innerHTML = `
      <section class="page-hero page-enter">
        <div>
          <a class="back-link" href="#/">Home</a>
          <span class="label">Timed practice</span>
          <h1>Exam Mode</h1>
          <p>Start a 90-minute attempt, hide solutions until after submission, and tag weak spots in your notebook.</p>
        </div>
      </section>
      <section class="exam-grid page-enter">
        ${exams.length ? exams.map(examCard).join("") : "<article class=\"empty\"><h3>No exams found</h3><p>The generated map did not expose exam PDFs.</p></article>"}
      </section>
    `;
  }

  function examItems() {
    const items = [];
    lessons.forEach((lesson) => {
      (lesson.resources.exams || []).forEach((exam, index) => {
        items.push({
          id: `${lesson.id}-exam-${index}`,
          lesson,
          exam,
          solution: (lesson.resources.examSolutions || [])[index] || (lesson.resources.examSolutions || [])[0],
        });
      });
    });
    return items;
  }

  function examCard(item) {
    const mode = uiState.examMode || {};
    const endTime = mode.timers[item.id] || 0;
    const attempted = Boolean(mode.attempted[item.id]);
    const flagged = Boolean(mode.flagged[item.id]);
    const confidence = mode.confidence[item.id] || "3";
    const notes = mode.notes[item.id] || "";
    return `
      <article class="exam-card ${flagged ? "flagged" : ""}">
        <div>
          <span class="label">${escapeHtml(item.lesson.module.title)}</span>
          <h2>${escapeHtml(item.exam.title.replace(/\.pdf$/i, ""))}</h2>
          <p>${escapeHtml(cleanTitle(item.lesson.lessonTitle))}</p>
        </div>
        <div class="exam-timer">${escapeHtml(timerText(endTime))}</div>
        <div class="action-row">
          <button class="button primary" type="button" data-start-exam="${escapeHtml(item.id)}">Start 90</button>
          <a class="button amber" href="${escapeHtml(resourceHref(item.exam))}" target="_blank" rel="noopener">Open Exam</a>
          ${attempted && item.solution ? `<a class="button red" href="${escapeHtml(resourceHref(item.solution))}" target="_blank" rel="noopener">Open Solution</a>` : ""}
        </div>
        <textarea class="exam-notes" data-exam-note="${escapeHtml(item.id)}" placeholder="Scratch notes and reflection.">${escapeHtml(notes)}</textarea>
        <div class="exam-controls">
          <label>
            <span>Confidence</span>
            <select data-exam-confidence="${escapeHtml(item.id)}">
              ${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${String(value) === String(confidence) ? "selected" : ""}>${value}/5</option>`).join("")}
            </select>
          </label>
          <label>
            <input type="checkbox" ${flagged ? "checked" : ""} data-exam-flag="${escapeHtml(item.id)}">
            <span>Flag problem</span>
          </label>
          <button class="button" type="button" data-submit-exam="${escapeHtml(item.id)}">${attempted ? "Attempt saved" : "Submit Attempt"}</button>
        </div>
      </article>
    `;
  }

  function timerText(endTime) {
    if (!endTime) return "90:00";
    const remaining = Math.max(0, endTime - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function renderNotebook() {
    const mistake = topMistake();
    const rows = mistakeRows();
    app.innerHTML = `
      <section class="page-hero page-enter">
        <div>
          <a class="back-link" href="#/">Home</a>
          <span class="label">Error Notebook</span>
          <h1>Your mistake patterns</h1>
          <p>${mistake ? `Top mistake: ${escapeHtml(labelForMistake(mistake.tag))}. Recommended: 10-minute review plus 3 practice problems.` : "Tag mistakes inside lesson mastery panels to build a useful review notebook."}</p>
        </div>
      </section>
      <section class="notebook-list page-enter">
        ${rows.length ? rows.map(notebookRow).join("") : "<article class=\"empty\"><h3>No mistake tags yet</h3><p>When a problem goes sideways, tag the reason on the lesson page.</p></article>"}
      </section>
    `;
  }

  function mistakeRows() {
    return MISTAKE_TAGS.map(([tag, label]) => {
      const taggedLessons = lessons.filter((lesson) => lessonState(lesson).mistakes.includes(tag));
      return taggedLessons.length ? { tag, label, lessons: taggedLessons } : null;
    }).filter(Boolean);
  }

  function notebookRow(row) {
    return `
      <article class="notebook-row">
        <div>
          <span class="label">${row.lessons.length} tagged</span>
          <h2>${escapeHtml(row.label)}</h2>
        </div>
        <div class="week-lessons">
          ${row.lessons.map((lesson) => `<a href="${lessonHref(lesson.id)}">${escapeHtml(cleanTitle(lesson.lessonTitle))}</a>`).join("")}
        </div>
      </article>
    `;
  }

  function weekRow(week) {
    const refs = weekLessons(week);
    const done = completeItems(refs);
    return `
      <article class="week-row">
        <div>
          <span class="label">${escapeHtml(week.week)}</span>
          <h2>${escapeHtml(week.title)}</h2>
          <p>${refs.length ? `${done}/${refs.length} complete` : "Warmup before Session 1"}</p>
        </div>
        <div class="week-lessons">
          ${
            refs.length
              ? refs.map((lesson) => `<a href="${lessonHref(lesson.id)}">${escapeHtml(cleanTitle(lesson.lessonTitle))}</a>`).join("")
              : "<span>Algebra</span><span>Functions</span><span>Trigonometry</span><span>Logarithms</span>"
          }
        </div>
      </article>
    `;
  }

  function renderSearchOverlay() {
    if (!searchOpen && !searchQuery.trim()) {
      searchOverlay.hidden = true;
      searchOverlay.innerHTML = "";
      return;
    }

    const query = searchQuery.trim().toLowerCase();
    const filter = uiState.searchFilter || "all";
    const matches = lessons
      .filter((lesson) => !query || searchable(lesson).includes(query))
      .filter((lesson) => searchFilterMatches(lesson, filter))
      .slice(0, 30);

    searchOverlay.hidden = false;
    searchOverlay.innerHTML = `
      <div class="search-card">
        <div class="search-head">
          <div>
            <span class="label">Command Search</span>
            <h2>${query ? `${matches.length} results` : "Find anything fast"}</h2>
          </div>
          <button class="button" type="button" data-close-search>Esc</button>
        </div>
        <div class="search-filters">
          ${["all", "lessons", "practice", "exams", "videos"].map(filterButton).join("")}
        </div>
        <div class="search-results">
          ${
            matches.length
              ? matches.map(searchResult).join("")
              : "<article class=\"empty\"><h3>No results</h3><p>Try a topic, session number, exam, or resource type.</p></article>"
          }
        </div>
      </div>
    `;
  }

  function filterButton(filter) {
    const active = (uiState.searchFilter || "all") === filter ? "active" : "";
    return `<button class="${active}" type="button" data-search-filter="${filter}">${filter}</button>`;
  }

  function searchFilterMatches(lesson, filter) {
    const resources = lesson.resources || {};
    if (filter === "lessons") return lesson.lessonType === "lesson";
    if (filter === "practice") return Boolean(resources.problems?.length || lesson.lessonType === "problem-set");
    if (filter === "exams") return Boolean(resources.exams?.length || resources.examSolutions?.length || lesson.lessonType.includes("exam"));
    if (filter === "videos") return Boolean(resources.videos?.length || lesson.youtube?.defaultVideos?.length);
    return true;
  }

  function searchResult(lesson) {
    return `
      <article class="search-result">
        <a href="${lessonHref(lesson.id)}" data-search-navigate>
          <span>${escapeHtml(lesson.module.title)}</span>
          <strong>${escapeHtml(cleanTitle(lesson.lessonTitle))}</strong>
        </a>
        <div>
          <a class="button primary compact" href="${lessonHref(lesson.id)}" data-search-navigate>Open</a>
          ${quickActions(lesson)}
        </div>
      </article>
    `;
  }

  function searchable(lesson) {
    const resources = allResources(lesson).map((resource) => resource.title).join(" ");
    const videos = (lesson.youtube?.defaultVideos || []).map((video) => video.title).join(" ");
    return [
      lesson.lessonTitle,
      lesson.moduleTitle,
      lesson.partTitle,
      lesson.topic,
      lesson.lessonType,
      lesson.sessionNumber ? `session ${lesson.sessionNumber}` : "",
      resources,
      videos,
    ]
      .join(" ")
      .toLowerCase();
  }

  function render() {
    updateProgress();
    renderNav();
    const current = route();
    if (current.name === "module") renderModule(current.id);
    else if (current.name === "lesson") renderLesson(current.id);
    else if (current.name === "plan") renderPlan();
    else if (current.name === "diagnostic") renderDiagnostic();
    else if (current.name === "exam-mode") renderExamMode();
    else if (current.name === "notebook") renderNotebook();
    else renderHome();
    renderSearchOverlay();
  }

  function youtubeInputFor(id) {
    return Array.from(document.querySelectorAll("[data-youtube-input]")).find(
      (input) => input.getAttribute("data-youtube-input") === id
    );
  }

  function noteInputFor(id) {
    return Array.from(document.querySelectorAll("[data-note-input]")).find(
      (input) => input.getAttribute("data-note-input") === id
    );
  }

  searchInput.addEventListener("focus", () => {
    searchOpen = true;
    renderSearchOverlay();
  });

  searchInput.addEventListener("input", (event) => {
    searchQuery = event.target.value;
    searchOpen = true;
    renderSearchOverlay();
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (event.key === "/" && !isTyping) {
      event.preventDefault();
      searchOpen = true;
      searchInput.focus();
      renderSearchOverlay();
    }
    if (event.key === "Escape") {
      searchQuery = "";
      searchOpen = false;
      searchInput.value = "";
      renderSearchOverlay();
      closeAuthModal();
    }
  });

  document.addEventListener("submit", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.hasAttribute("data-auth-form")) {
      event.preventDefault();
      handleAuthAction("sign-in");
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const statusId = target.getAttribute("data-status-id");
    if (statusId && target instanceof HTMLSelectElement) {
      updateLessonState(statusId, { status: target.value });
      render();
      return;
    }

    const confidenceId = target.getAttribute("data-confidence-id");
    if (confidenceId && target instanceof HTMLInputElement) {
      const confidence = Number(target.value);
      const lesson = lessonsById.get(confidenceId);
      if (!lesson) return;
      const state = lessonState(lesson);
      updateLessonState(confidenceId, {
        confidence,
        nextReviewAt: reviewDateFor(state.status, confidence),
      });
      render();
      return;
    }

    const mistakeId = target.getAttribute("data-mistake-id");
    if (mistakeId && target instanceof HTMLInputElement) {
      const tag = target.getAttribute("data-mistake-tag");
      if (!tag) return;
      const lesson = lessonsById.get(mistakeId);
      if (!lesson) return;
      const state = lessonState(lesson);
      const mistakes = new Set(state.mistakes);
      if (target.checked) mistakes.add(tag);
      else mistakes.delete(tag);
      updateLessonState(mistakeId, {
        mistakes: Array.from(mistakes),
        status: target.checked && state.status === "not-started" ? "got-stuck" : state.status,
      });
      render();
      return;
    }

    const diagnosticId = target.getAttribute("data-diagnostic-answer");
    if (diagnosticId && target instanceof HTMLInputElement) {
      uiState.diagnosticAnswers[diagnosticId] = Number(target.value);
      writeStore(STORAGE_UI, uiState);
      render();
      return;
    }

    const examConfidence = target.getAttribute("data-exam-confidence");
    if (examConfidence && target instanceof HTMLSelectElement) {
      uiState.examMode.confidence[examConfidence] = target.value;
      writeStore(STORAGE_UI, uiState);
      return;
    }

    const examFlag = target.getAttribute("data-exam-flag");
    if (examFlag && target instanceof HTMLInputElement) {
      uiState.examMode.flagged[examFlag] = target.checked;
      writeStore(STORAGE_UI, uiState);
      render();
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const noteId = target.getAttribute("data-note-input");
    if (noteId) {
      const input = noteInputFor(noteId);
      lessonNotes[noteId] = input ? input.value : "";
      writeStore(STORAGE_NOTES, lessonNotes);
      return;
    }

    const examNote = target.getAttribute("data-exam-note");
    if (examNote && target instanceof HTMLTextAreaElement) {
      uiState.examMode.notes[examNote] = target.value;
      writeStore(STORAGE_UI, uiState);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.closest("[data-open-auth]")) {
      openAuthModal();
      return;
    }

    if (target.closest("[data-close-auth]")) {
      closeAuthModal();
      return;
    }

    const authAction = target.closest("[data-auth-action]")?.getAttribute("data-auth-action");
    if (authAction) {
      handleAuthAction(authAction);
      return;
    }

    if (target.closest("[data-sync-now]")) {
      saveCloudState();
      return;
    }

    if (target.closest("[data-sign-out]")) {
      signOut();
      return;
    }

    const stuckId = target.closest("[data-toggle-stuck]")?.getAttribute("data-toggle-stuck");
    if (stuckId) {
      uiState.stuckLessons[stuckId] = !uiState.stuckLessons[stuckId];
      writeStore(STORAGE_UI, uiState);
      if (uiState.stuckLessons[stuckId]) {
        const lesson = lessonsById.get(stuckId);
        if (lesson && lessonState(lesson).status === "not-started") {
          updateLessonState(stuckId, { status: "got-stuck" });
        }
      }
      render();
      return;
    }

    const startExam = target.closest("[data-start-exam]")?.getAttribute("data-start-exam");
    if (startExam) {
      uiState.examMode.timers[startExam] = Date.now() + 90 * 60 * 1000;
      uiState.examMode.attempted[startExam] = false;
      writeStore(STORAGE_UI, uiState);
      render();
      return;
    }

    const submitExam = target.closest("[data-submit-exam]")?.getAttribute("data-submit-exam");
    if (submitExam) {
      uiState.examMode.attempted[submitExam] = true;
      writeStore(STORAGE_UI, uiState);
      render();
      return;
    }

    const saveId = target.getAttribute("data-save-youtube");
    if (saveId) {
      const input = youtubeInputFor(saveId);
      youtubeLinks[saveId] = input ? input.value.trim() : "";
      writeStore(STORAGE_YOUTUBE, youtubeLinks);
      render();
      return;
    }

    const openId = target.getAttribute("data-open-youtube");
    if (openId) {
      const input = youtubeInputFor(openId);
      const url = input && input.value.trim() ? input.value.trim() : youtubeLinks[openId];
      if (url) {
        youtubeLinks[openId] = url;
        writeStore(STORAGE_YOUTUBE, youtubeLinks);
        window.open(url, "_blank", "noopener");
      }
      return;
    }

    const videoButton = target.closest("[data-use-ocw-video]");
    const useVideoId = videoButton?.getAttribute("data-use-ocw-video");
    if (useVideoId) {
      youtubeLinks[useVideoId] = videoButton.getAttribute("data-video-url") || "";
      writeStore(STORAGE_YOUTUBE, youtubeLinks);
      render();
      return;
    }

    const partId = target.closest("[data-toggle-part]")?.getAttribute("data-toggle-part");
    if (partId) {
      uiState.collapsedParts[partId] = !uiState.collapsedParts[partId];
      writeStore(STORAGE_UI, uiState);
      render();
      return;
    }

    const filter = target.getAttribute("data-search-filter");
    if (filter) {
      uiState.searchFilter = filter;
      writeStore(STORAGE_UI, uiState);
      renderSearchOverlay();
      return;
    }

    if (target.hasAttribute("data-close-search")) {
      searchQuery = "";
      searchOpen = false;
      searchInput.value = "";
      renderSearchOverlay();
      return;
    }

    if (target.closest("[data-search-navigate]")) {
      searchQuery = "";
      searchOpen = false;
      searchInput.value = "";
      renderSearchOverlay();
    }
  });

  window.addEventListener("hashchange", render);
  window.setInterval(() => {
    if (route().name === "exam-mode") render();
  }, 1000);
  render();
  loadSupplementalData();
  initSupabaseAuth();
})();
