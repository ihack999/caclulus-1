(function () {
  "use strict";

  const STORAGE_PROGRESS = "engineering-calc1-progress-v1";
  const STORAGE_YOUTUBE = "engineering-calc1-youtube-v1";
  const STORAGE_NOTES = "engineering-calc1-notes-v1";
  const STORAGE_UI = "engineering-calc1-ui-v1";
  const SUPABASE_TABLE = "user_course_state";
  const SYNCED_STORAGE_KEYS = new Set([STORAGE_PROGRESS, STORAGE_YOUTUBE, STORAGE_NOTES, STORAGE_UI]);

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
  let uiState = {
    collapsedParts: {},
    searchFilter: "all",
    ...readStore(STORAGE_UI),
  };
  let searchQuery = "";
  let searchOpen = false;
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
    const mergedUi = {
      collapsedParts: {},
      searchFilter: "all",
      ...(row.ui_state || {}),
      ...uiState,
      collapsedParts: {
        ...((row.ui_state || {}).collapsedParts || {}),
        ...(uiState.collapsedParts || {}),
      },
    };

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

  function route() {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean).map(decodeURIComponent);
    if (!parts.length) return { name: "home" };
    if (parts[0] === "module") return { name: "module", id: parts.slice(1).join("/") };
    if (parts[0] === "lesson") return { name: "lesson", id: parts.slice(1).join("/") };
    if (parts[0] === "plan") return { name: "plan" };
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

  function completeItems(items = lessons) {
    return items.filter((lesson) => progress[lesson.id]).length;
  }

  function percent(done, total) {
    return total ? Math.round((done / total) * 100) : 0;
  }

  function nextLesson(items = lessons) {
    return items.find((lesson) => !progress[lesson.id]) || items[0] || null;
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

  function courseIntroButton() {
    const intro = data.course.introVideos?.[0];
    if (!intro) return "";
    return `<a class="button blue xl" href="${escapeHtml(intro.watchUrl || intro.url)}" target="_blank" rel="noopener">Course Intro</a>`;
  }

  function timelineLesson(lesson, index) {
    const done = progress[lesson.id] ? "done" : "";
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
    const checked = progress[lesson.id] ? "checked" : "";
    const resources = allResources(lesson);
    return `
      <article class="lesson-row ${checked ? "complete" : ""}">
        <input type="checkbox" ${checked} data-progress-id="${escapeHtml(lesson.id)}" aria-label="Mark complete">
        <a class="lesson-main" href="${lessonHref(lesson.id)}">
          <strong>${escapeHtml(cleanTitle(lesson.lessonTitle))}</strong>
          <span>${escapeHtml(lesson.sessionNumber ? `Session ${lesson.sessionNumber}` : lesson.lessonType)} / ${escapeHtml(lesson.topic)}</span>
        </a>
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
    const checked = progress[lesson.id] ? "checked" : "";
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
          <label class="complete-pill">
            <input type="checkbox" ${checked} data-progress-id="${escapeHtml(lesson.id)}">
            <span>Complete</span>
          </label>
        </div>
      </section>

      <section class="guided-studio page-enter">
        ${watchPanel(lesson, savedVideo)}
        ${resourcePanel("Read", "Lecture notes", lesson.resources.notes, "blue")}
        ${resourcePanel("Practice", "Problems", (lesson.resources.problems || []).concat(lesson.resources.exams || []), "amber")}
        ${resourcePanel("Check", "Solutions", (lesson.resources.solutions || []).concat(lesson.resources.examSolutions || []), "red")}
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
    const id = target.getAttribute("data-progress-id");
    if (!id) return;
    progress[id] = target.checked;
    writeStore(STORAGE_PROGRESS, progress);
    render();
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const noteId = target.getAttribute("data-note-input");
    if (!noteId) return;
    const input = noteInputFor(noteId);
    lessonNotes[noteId] = input ? input.value : "";
    writeStore(STORAGE_NOTES, lessonNotes);
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
  render();
  initSupabaseAuth();
})();
