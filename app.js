(function () {
  "use strict";

  const DOMAINS = window.DOMAINS;
  const QUESTIONS = window.QUESTIONS;
  const FLASHCARDS = window.FLASHCARDS;
  const PASS_SCORE = 720; // scaled score out of 1000
  const SECONDS_PER_QUESTION = 120;
  const STORE_KEY = "cca-prep-v1";

  const app = document.getElementById("app");
  const domainById = Object.fromEntries(DOMAINS.map((d) => [d.id, d]));

  // ───────────── Storage ─────────────
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign(emptyStore(), JSON.parse(raw));
    } catch (e) {
      /* storage unavailable — fall back to in-memory */
    }
    return emptyStore();
  }
  function emptyStore() {
    return { answers: {}, exams: [], cards: {} };
  }
  let store = loadStore();
  function saveStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (e) {
      /* ignore */
    }
  }
  function recordAnswer(qid, correct) {
    const a = store.answers[qid] || { correct: 0, wrong: 0, last: null };
    if (correct) a.correct++;
    else a.wrong++;
    a.last = correct;
    store.answers[qid] = a;
    saveStore();
  }

  // ───────────── Helpers ─────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function pct(n, d) {
    return d ? Math.round((n / d) * 100) : 0;
  }
  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const LETTERS = "ABCDEFGH";

  // Build a question instance with shuffled options, tracking the correct index.
  function prepare(q) {
    const order = shuffle(q.options.map((_, i) => i));
    return {
      ...q,
      shuffled: order.map((i) => q.options[i]),
      correctIndex: order.indexOf(q.answer),
    };
  }

  function domainStats(domainId) {
    const qs = QUESTIONS.filter((q) => !domainId || q.domain === domainId);
    let attempted = 0, correct = 0, total = 0;
    qs.forEach((q) => {
      const a = store.answers[q.id];
      if (a) {
        attempted++;
        correct += a.correct;
        total += a.correct + a.wrong;
      }
    });
    return { count: qs.length, attempted, correct, total, accuracy: pct(correct, total) };
  }

  function mistakes(domainId) {
    return QUESTIONS.filter(
      (q) => (!domainId || q.domain === domainId) && store.answers[q.id] && store.answers[q.id].last === false
    );
  }

  // ───────────── Router ─────────────
  let cleanup = null;
  function route() {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    const hash = location.hash.replace(/^#\/?/, "");
    const [view, param] = hash.split("/");
    document.querySelectorAll("[data-nav]").forEach((a) => {
      a.classList.toggle("active", a.dataset.nav === (view || "home"));
    });
    window.scrollTo(0, 0);
    switch (view) {
      case "practice":
        return param ? startPractice(param) : renderPracticeMenu();
      case "exam":
        return renderExamMenu();
      case "cards":
        return renderCards(param);
      case "stats":
        return renderStats();
      default:
        return renderHome();
    }
  }
  window.addEventListener("hashchange", route);

  // ───────────── Home ─────────────
  function renderHome() {
    const all = domainStats();
    const lastExam = store.exams[store.exams.length - 1];
    app.innerHTML = `
      <h1>Claude Certified Architect prep</h1>
      <p class="lead">Practice by domain, take timed mock exams, review flashcards and track your progress. Everything is saved in your browser.</p>
      <div class="kpis">
        <div class="card kpi"><div class="value">${all.attempted}/${all.count}</div><div class="label">Questions attempted</div></div>
        <div class="card kpi"><div class="value">${all.total ? all.accuracy + "%" : "—"}</div><div class="label">Practice accuracy</div></div>
        <div class="card kpi"><div class="value">${lastExam ? lastExam.scaled : "—"}</div><div class="label">Last mock exam (pass ${PASS_SCORE})</div></div>
        <div class="card kpi"><div class="value">${mistakes().length}</div><div class="label">Questions to review</div></div>
      </div>
      <h2>Exam domains</h2>
      <div class="grid">
        ${DOMAINS.map((d) => {
          const s = domainStats(d.id);
          return `
          <div class="card domain-card">
            <span class="tag">${d.weight}% of exam</span>
            <h3>${esc(d.name)}</h3>
            <p>${esc(d.description)}</p>
            <div class="bar ${s.total ? (s.accuracy >= 72 ? "good" : "bad") : ""}"><div style="width:${s.accuracy}%"></div></div>
            <div class="small muted">${s.attempted}/${s.count} attempted · ${s.total ? s.accuracy + "% correct" : "not started"}</div>
            <div class="row">
              <a class="btn small primary" href="#/practice/${d.id}">Practice</a>
              <a class="btn small" href="#/cards/${d.id}">Flashcards</a>
            </div>
          </div>`;
        }).join("")}
      </div>`;
  }

  // ───────────── Practice ─────────────
  function renderPracticeMenu() {
    const m = mistakes();
    app.innerHTML = `
      <h1>Practice by domain</h1>
      <p class="lead">Answer questions one at a time and see the explanation immediately.</p>
      <div class="grid">
        <div class="card domain-card">
          <h3>All domains</h3>
          <p>${QUESTIONS.length} questions, shuffled.</p>
          <div class="row"><a class="btn small primary" href="#/practice/all">Start</a></div>
        </div>
        <div class="card domain-card">
          <h3>Review mistakes</h3>
          <p>${m.length} question${m.length === 1 ? "" : "s"} you last answered incorrectly.</p>
          <div class="row"><a class="btn small primary ${m.length ? "" : "disabled"}" href="${m.length ? "#/practice/mistakes" : "#/practice"}">Start</a></div>
        </div>
        ${DOMAINS.map((d) => {
          const s = domainStats(d.id);
          return `
          <div class="card domain-card">
            <span class="tag">${d.weight}%</span>
            <h3>${esc(d.name)}</h3>
            <p>${s.count} questions · ${s.total ? s.accuracy + "% correct" : "not started"}</p>
            <div class="row"><a class="btn small primary" href="#/practice/${d.id}">Start</a></div>
          </div>`;
        }).join("")}
      </div>`;
  }

  function startPractice(param) {
    let pool;
    let title;
    if (param === "all") {
      pool = QUESTIONS;
      title = "All domains";
    } else if (param === "mistakes") {
      pool = mistakes();
      title = "Review mistakes";
    } else if (domainById[param]) {
      pool = QUESTIONS.filter((q) => q.domain === param);
      title = domainById[param].name;
    } else {
      location.hash = "#/practice";
      return;
    }
    if (!pool.length) {
      app.innerHTML = `<h1>${esc(title)}</h1><p class="lead">Nothing to practice here yet.</p><a class="btn" href="#/practice">Back</a>`;
      return;
    }
    const qs = shuffle(pool).map(prepare);
    let idx = 0;
    let score = 0;

    function show() {
      const q = qs[idx];
      app.innerHTML = `
        <div class="quiz-head">
          <div><strong>${esc(title)}</strong><div class="small muted">Question ${idx + 1} of ${qs.length} · ${score} correct</div></div>
          <span class="tag">${esc(domainById[q.domain].short)}</span>
        </div>
        <div class="bar"><div style="width:${pct(idx, qs.length)}%"></div></div>
        <div class="question">${esc(q.question)}</div>
        <div class="options">
          ${q.shuffled.map((o, i) => `<button class="option" data-i="${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></button>`).join("")}
        </div>
        <div id="feedback"></div>`;
      app.querySelectorAll(".option").forEach((btn) => {
        btn.addEventListener("click", () => answer(Number(btn.dataset.i)));
      });
    }

    function answer(i) {
      const q = qs[idx];
      const correct = i === q.correctIndex;
      if (correct) score++;
      recordAnswer(q.id, correct);
      app.querySelectorAll(".option").forEach((btn) => {
        const bi = Number(btn.dataset.i);
        btn.disabled = true;
        if (bi === q.correctIndex) btn.classList.add("correct");
        else if (bi === i) btn.classList.add("wrong");
      });
      const last = idx === qs.length - 1;
      document.getElementById("feedback").innerHTML = `
        <div class="explanation ${correct ? "good" : "bad"}">
          <strong>${correct ? "Correct!" : "Not quite."}</strong> ${esc(q.explanation)}
        </div>
        <div class="btn-row"><button class="btn primary" id="next">${last ? "See results" : "Next question →"}</button></div>`;
      const next = document.getElementById("next");
      next.focus();
      next.addEventListener("click", () => {
        if (last) finish();
        else {
          idx++;
          show();
        }
      });
    }

    function finish() {
      const p = pct(score, qs.length);
      app.innerHTML = `
        <h1>${esc(title)} — done</h1>
        <div class="card">
          <div class="result-score ${p >= 72 ? "pass" : "fail"}">${p}%</div>
          <div class="muted">${score} of ${qs.length} correct</div>
          <div class="btn-row">
            <a class="btn primary" href="#/practice/${param}" id="again">Practice again</a>
            ${mistakes().length ? `<a class="btn" href="#/practice/mistakes">Review mistakes</a>` : ""}
            <a class="btn" href="#/practice">All topics</a>
          </div>
        </div>`;
      // Same hash won't trigger hashchange, so restart manually.
      document.getElementById("again").addEventListener("click", (e) => {
        e.preventDefault();
        startPractice(param);
      });
    }

    show();
  }

  // ───────────── Mock exam ─────────────
  function renderExamMenu() {
    const max = QUESTIONS.length;
    const sizes = [20, 40, max].filter((n, i, a) => n <= max && a.indexOf(n) === i);
    app.innerHTML = `
      <h1>Mock exam</h1>
      <p class="lead">Scenario-style multiple-choice questions drawn proportionally to domain weights. No feedback until the end. Scored on a 100–1000 scale; ${PASS_SCORE} to pass.</p>
      <div class="card">
        <div class="field">
          <label for="size"><strong>Number of questions</strong></label>
          <select id="size">${sizes.map((n) => `<option value="${n}">${n} questions · ${Math.round((n * SECONDS_PER_QUESTION) / 60)} min</option>`).join("")}</select>
        </div>
        <button class="btn primary" id="start">Start exam</button>
      </div>
      ${store.exams.length ? `<h2>Previous attempts</h2>${examHistoryTable()}` : ""}`;
    document.getElementById("start").addEventListener("click", () => {
      startExam(Number(document.getElementById("size").value));
    });
  }

  function pickExamQuestions(n) {
    // Allocate questions per domain by weight (largest remainder), capped by availability.
    const totalW = DOMAINS.reduce((s, d) => s + d.weight, 0);
    const alloc = DOMAINS.map((d) => {
      const exact = (d.weight / totalW) * n;
      return { d, n: Math.floor(exact), rem: exact - Math.floor(exact) };
    });
    let left = n - alloc.reduce((s, a) => s + a.n, 0);
    alloc.slice().sort((a, b) => b.rem - a.rem).forEach((a) => {
      if (left > 0) { a.n++; left--; }
    });
    const picked = [];
    const leftovers = [];
    alloc.forEach((a) => {
      const pool = shuffle(QUESTIONS.filter((q) => q.domain === a.d.id));
      picked.push(...pool.slice(0, a.n));
      leftovers.push(...pool.slice(a.n));
    });
    // Fill any shortfall from other domains.
    shuffle(leftovers).slice(0, n - picked.length).forEach((q) => picked.push(q));
    return shuffle(picked).map(prepare);
  }

  function startExam(n) {
    const qs = pickExamQuestions(n);
    const chosen = new Array(qs.length).fill(null);
    let idx = 0;
    let remaining = qs.length * SECONDS_PER_QUESTION;
    let finished = false;

    const timer = setInterval(() => {
      remaining--;
      const el = document.getElementById("timer");
      if (el) {
        el.textContent = fmtTime(remaining);
        el.classList.toggle("low", remaining < 300);
      }
      if (remaining <= 0) submit();
    }, 1000);
    cleanup = () => clearInterval(timer);

    function show() {
      const q = qs[idx];
      const answered = chosen.filter((c) => c !== null).length;
      app.innerHTML = `
        <div class="quiz-head">
          <div><strong>Mock exam</strong><div class="small muted">Question ${idx + 1} of ${qs.length} · ${answered} answered</div></div>
          <div>⏱ <span id="timer" class="timer ${remaining < 300 ? "low" : ""}">${fmtTime(remaining)}</span></div>
        </div>
        <div class="bar"><div style="width:${pct(answered, qs.length)}%"></div></div>
        <div class="question">${esc(q.question)}</div>
        <div class="options">
          ${q.shuffled.map((o, i) => `<button class="option ${chosen[idx] === i ? "selected" : ""}" data-i="${i}"><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></button>`).join("")}
        </div>
        <div class="btn-row">
          <button class="btn" id="prev" ${idx === 0 ? "disabled" : ""}>← Previous</button>
          ${idx < qs.length - 1 ? `<button class="btn primary" id="next">Next →</button>` : ""}
          <button class="btn ${idx === qs.length - 1 ? "primary" : ""}" id="submit">Submit exam</button>
        </div>
        <div class="navgrid">
          ${qs.map((_, i) => `<button data-go="${i}" class="${chosen[i] !== null ? "answered" : ""} ${i === idx ? "current" : ""}">${i + 1}</button>`).join("")}
        </div>`;
      app.querySelectorAll(".option").forEach((btn) =>
        btn.addEventListener("click", () => {
          chosen[idx] = Number(btn.dataset.i);
          show();
        })
      );
      app.querySelectorAll("[data-go]").forEach((btn) =>
        btn.addEventListener("click", () => {
          idx = Number(btn.dataset.go);
          show();
        })
      );
      document.getElementById("prev").addEventListener("click", () => { idx--; show(); });
      const next = document.getElementById("next");
      if (next) next.addEventListener("click", () => { idx++; show(); });
      document.getElementById("submit").addEventListener("click", () => {
        const unanswered = chosen.filter((c) => c === null).length;
        if (unanswered && !confirm(`You have ${unanswered} unanswered question(s). Submit anyway?`)) return;
        submit();
      });
    }

    function submit() {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      cleanup = null;

      const perDomain = {};
      let correct = 0;
      qs.forEach((q, i) => {
        const ok = chosen[i] === q.correctIndex;
        if (ok) correct++;
        recordAnswer(q.id, ok);
        const pd = perDomain[q.domain] || (perDomain[q.domain] = { correct: 0, total: 0 });
        pd.total++;
        if (ok) pd.correct++;
      });
      const scaled = Math.round(100 + (correct / qs.length) * 900);
      const passed = scaled >= PASS_SCORE;
      store.exams.push({
        date: new Date().toISOString(),
        correct,
        total: qs.length,
        scaled,
        passed,
        perDomain,
        timeUsed: qs.length * SECONDS_PER_QUESTION - remaining,
      });
      saveStore();

      app.innerHTML = `
        <h1>Exam results</h1>
        <div class="card">
          <div class="result-score ${passed ? "pass" : "fail"}">${scaled}</div>
          <div><strong class="${passed ? "pass" : "fail"}">${passed ? "PASS" : "FAIL"}</strong> <span class="muted">· ${correct}/${qs.length} correct · passing score ${PASS_SCORE}</span></div>
          <h2>By domain</h2>
          ${DOMAINS.filter((d) => perDomain[d.id]).map((d) => {
            const s = perDomain[d.id];
            const p = pct(s.correct, s.total);
            return `<div class="stat-row"><div><div class="name">${esc(d.name)} <span class="muted small">(${s.correct}/${s.total})</span></div><div class="bar ${p >= 72 ? "good" : "bad"}"><div style="width:${p}%"></div></div></div><div class="pct">${p}%</div></div>`;
          }).join("")}
          <div class="btn-row">
            <button class="btn primary" id="review">Review answers</button>
            <a class="btn" href="#/practice/mistakes">Practice mistakes</a>
            <a class="btn" href="#/">Home</a>
          </div>
        </div>
        <div id="review-list"></div>`;
      document.getElementById("review").addEventListener("click", () => {
        document.getElementById("review-list").innerHTML = qs.map((q, i) => {
          const ok = chosen[i] === q.correctIndex;
          return `
          <div class="card" style="margin-top:12px">
            <div class="quiz-head"><strong>Q${i + 1}</strong><span class="tag">${esc(domainById[q.domain].short)}</span></div>
            <div class="question">${esc(q.question)}</div>
            <div class="options">
              ${q.shuffled.map((o, oi) => `<button disabled class="option ${oi === q.correctIndex ? "correct" : oi === chosen[i] ? "wrong" : ""}"><span class="letter">${LETTERS[oi]}</span><span>${esc(o)}</span></button>`).join("")}
            </div>
            <div class="explanation ${ok ? "good" : "bad"}"><strong>${ok ? "Correct." : chosen[i] === null ? "Not answered." : "Incorrect."}</strong> ${esc(q.explanation)}</div>
          </div>`;
        }).join("");
        document.getElementById("review").disabled = true;
      });
    }

    show();
  }

  function examHistoryTable() {
    return `
      <div class="card" style="overflow-x:auto">
        <table>
          <thead><tr><th>Date</th><th>Score</th><th>Correct</th><th>Result</th></tr></thead>
          <tbody>
            ${store.exams.slice().reverse().map((e) => `
              <tr>
                <td>${new Date(e.date).toLocaleString()}</td>
                <td><strong>${e.scaled}</strong></td>
                <td>${e.correct}/${e.total}</td>
                <td class="${e.passed ? "pass" : "fail"}">${e.passed ? "Pass" : "Fail"}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  // ───────────── Flashcards ─────────────
  function cardKey(c) {
    return c.domain + "::" + c.front;
  }

  function renderCards(domainParam) {
    const domainId = domainById[domainParam] ? domainParam : "all";
    let onlyUnknown = false;
    let deck = [];
    let idx = 0;

    function buildDeck() {
      deck = shuffle(
        FLASHCARDS.filter(
          (c) => (domainId === "all" || c.domain === domainId) && (!onlyUnknown || !store.cards[cardKey(c)])
        )
      );
      idx = 0;
    }

    function show() {
      const pool = FLASHCARDS.filter((c) => domainId === "all" || c.domain === domainId);
      const known = pool.filter((c) => store.cards[cardKey(c)]).length;
      const card = deck[idx];
      app.innerHTML = `
        <h1>Flashcards</h1>
        <div class="quiz-head">
          <select id="deck">
            <option value="all">All domains (${FLASHCARDS.length})</option>
            ${DOMAINS.map((d) => `<option value="${d.id}" ${d.id === domainId ? "selected" : ""}>${esc(d.name)} (${FLASHCARDS.filter((c) => c.domain === d.id).length})</option>`).join("")}
          </select>
          <label class="small"><input type="checkbox" id="unknown" ${onlyUnknown ? "checked" : ""}/> Only cards I don't know yet</label>
        </div>
        <div class="small muted">Known: ${known}/${pool.length}</div>
        <div class="bar good" style="margin-top:6px"><div style="width:${pct(known, pool.length)}%"></div></div>
        ${card ? `
          <div class="small muted" style="margin-top:16px">Card ${idx + 1} of ${deck.length} · <span class="tag">${esc(domainById[card.domain].short)}</span></div>
          <div class="flashcard" id="fc">
            <div class="flashcard-inner">
              <div class="flashcard-face front">${esc(card.front)}<div class="hint">Click or press Space to flip</div></div>
              <div class="flashcard-face back">${esc(card.back)}</div>
            </div>
          </div>
          <div class="btn-row">
            <button class="btn" id="prev" ${idx === 0 ? "disabled" : ""}>← Back</button>
            <button class="btn" id="again">Still learning</button>
            <button class="btn primary" id="know">I know this ✓</button>
          </div>`
        : `<div class="card" style="margin-top:16px"><strong>Deck complete!</strong><p class="muted">You've gone through every card in this selection.</p><button class="btn primary" id="restart">Shuffle &amp; restart</button></div>`}`;

      document.getElementById("deck").addEventListener("change", (e) => {
        location.hash = "#/cards/" + e.target.value;
      });
      document.getElementById("unknown").addEventListener("change", (e) => {
        onlyUnknown = e.target.checked;
        buildDeck();
        show();
      });
      if (card) {
        const fc = document.getElementById("fc");
        fc.addEventListener("click", () => fc.classList.toggle("flipped"));
        document.getElementById("prev").addEventListener("click", () => { idx--; show(); });
        document.getElementById("again").addEventListener("click", () => mark(false));
        document.getElementById("know").addEventListener("click", () => mark(true));
      } else {
        document.getElementById("restart").addEventListener("click", () => { buildDeck(); show(); });
      }
    }

    function mark(known) {
      const key = cardKey(deck[idx]);
      if (known) store.cards[key] = true;
      else delete store.cards[key];
      saveStore();
      idx++;
      show();
    }

    function onKey(e) {
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
      const fc = document.getElementById("fc");
      if (!fc) return;
      if (e.key === " ") { e.preventDefault(); fc.classList.toggle("flipped"); }
      else if (e.key === "ArrowRight") mark(true);
      else if (e.key === "ArrowLeft" && idx > 0) { idx--; show(); }
    }
    document.addEventListener("keydown", onKey);
    cleanup = () => document.removeEventListener("keydown", onKey);

    buildDeck();
    show();
  }

  // ───────────── Stats ─────────────
  function renderStats() {
    const all = domainStats();
    const knownCards = FLASHCARDS.filter((c) => store.cards[cardKey(c)]).length;
    const best = store.exams.reduce((m, e) => Math.max(m, e.scaled), 0);
    app.innerHTML = `
      <h1>Your progress</h1>
      <div class="kpis">
        <div class="card kpi"><div class="value">${all.attempted}/${all.count}</div><div class="label">Questions attempted</div></div>
        <div class="card kpi"><div class="value">${all.total ? all.accuracy + "%" : "—"}</div><div class="label">Overall accuracy</div></div>
        <div class="card kpi"><div class="value">${store.exams.length ? best : "—"}</div><div class="label">Best mock exam</div></div>
        <div class="card kpi"><div class="value">${knownCards}/${FLASHCARDS.length}</div><div class="label">Flashcards known</div></div>
      </div>
      <h2>Accuracy by domain</h2>
      <div class="card">
        ${DOMAINS.map((d) => {
          const s = domainStats(d.id);
          const cards = FLASHCARDS.filter((c) => c.domain === d.id);
          const kc = cards.filter((c) => store.cards[cardKey(c)]).length;
          return `<div class="stat-row">
            <div>
              <div class="name">${esc(d.name)} <span class="muted small">· ${d.weight}% of exam · ${s.attempted}/${s.count} attempted · cards ${kc}/${cards.length} · ${mistakes(d.id).length} to review</span></div>
              <div class="bar ${s.total ? (s.accuracy >= 72 ? "good" : "bad") : ""}"><div style="width:${s.accuracy}%"></div></div>
            </div>
            <div class="pct">${s.total ? s.accuracy + "%" : "—"}</div>
          </div>`;
        }).join("")}
        <p class="small muted">Green = at or above 72% (roughly the passing threshold). Focus on red domains with the highest exam weight first.</p>
      </div>
      <h2>Mock exam history</h2>
      ${store.exams.length ? examHistoryTable() : `<p class="muted">No mock exams yet. <a href="#/exam">Take one</a>.</p>`}
      <div class="btn-row"><button class="btn" id="reset">Reset all progress</button></div>`;
    document.getElementById("reset").addEventListener("click", () => {
      if (confirm("Delete all saved answers, exam history and flashcard progress?")) {
        store = emptyStore();
        saveStore();
        renderStats();
      }
    });
  }

  route();
})();
