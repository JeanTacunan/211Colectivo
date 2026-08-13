const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const state = { authMode: "register", rating: 0, user: null, reviews: [], showAllReviews: false, pendingReview: false };

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "No se pudo completar la solicitud.");
  return data;
}

function limaNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type)?.value;
  return { day: value("weekday"), minutes: Number(value("hour")) * 60 + Number(value("minute")) };
}

function updateStatus() {
  const { day, minutes } = limaNow();
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day);
  const active = (weekday && minutes >= 1110 && minutes <= 1439) ||
    (day === "Sat" && minutes >= 1080) ||
    (day === "Sun" && (minutes <= 120 || minutes >= 1080));
  $("#statusDot").classList.toggle("on", active);
  $("#statusText").textContent = active ? "En servicio ahora" : "Fuera de horario";
  $("#statusDetail").textContent = active ? "Disponible en la ruta · Hora de Perú" : "Revisa el próximo turno · Hora de Perú";
  $("#heroStatusDot").classList.toggle("on", active);
  $("#heroStatusText").textContent = active ? "Disponible ahora" : "Fuera de horario";
  $("#mobileStatusDot").classList.toggle("on", active);
  $("#mobileStatusText").textContent = active ? "Disponible · Horario" : "Ver horario";
}

const observer = new IntersectionObserver(entries => entries.forEach(entry => {
  if (entry.isIntersecting) entry.target.classList.add("visible");
}), { threshold: .12 });
$$('.reveal').forEach(element => observer.observe(element));

const menuToggle = $(".menu-toggle");
const mainNav = $("#mainNav");
menuToggle.addEventListener("click", () => {
  const open = mainNav.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(open));
});
$$('#mainNav a').forEach(link => link.addEventListener("click", () => {
  mainNav.classList.remove("open");
  menuToggle.setAttribute("aria-expanded", "false");
}));

const modal = $("#authModal");
const authForm = $("#authForm");
const authMessage = $("#authMessage");

function openModal() {
  modal.hidden = false;
  document.body.classList.add("modal-open");
  setTimeout(() => $(state.authMode === "register" ? "#authName" : "#authEmail").focus(), 20);
}
function closeModal(resetPending = true) {
  modal.hidden = true;
  document.body.classList.remove("modal-open");
  authMessage.textContent = "";
  if (resetPending) state.pendingReview = false;
}
function setAuthMode(mode) {
  state.authMode = mode;
  $$('[data-auth-tab]').forEach(tab => {
    const active = tab.dataset.authTab === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  const registering = mode === "register";
  $("#nameLabel").hidden = !registering;
  $("#authName").hidden = !registering;
  $("#authName").required = registering;
  $("#authPassword").autocomplete = registering ? "new-password" : "current-password";
  $("#authSubmit").textContent = registering ? "Crear mi cuenta" : "Ingresar";
  $("#authTitle").textContent = registering ? "Únete a la comunidad" : "Qué bueno verte";
  authMessage.textContent = "";
}

$("#accountButton").addEventListener("click", async () => {
  if (!state.user) return openModal();
  if (!confirm(`Sesión iniciada como ${state.user.name}. ¿Quieres cerrar sesión?`)) return;
  try { await api("/api/logout", { method: "POST", body: "{}" }); }
  finally { state.user = null; updateAuthUI(); }
});
$("#signinPrompt").addEventListener("click", openModal);
$$('[data-close-modal]').forEach(element => element.addEventListener("click", closeModal));
$$('[data-auth-tab]').forEach(tab => tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab)));
document.addEventListener("keydown", event => { if (event.key === "Escape" && !modal.hidden) closeModal(); });

authForm.addEventListener("submit", async event => {
  event.preventDefault();
  authMessage.textContent = "";
  $("#authSubmit").disabled = true;
  const payload = {
    name: $("#authName").value.trim(),
    email: $("#authEmail").value.trim().toLowerCase(),
    password: $("#authPassword").value
  };
  try {
    const data = await api(`/api/${state.authMode}`, { method: "POST", body: JSON.stringify(payload) });
    state.user = data.user;
    authForm.reset();
    closeModal(false);
    updateAuthUI();
    if (state.pendingReview) {
      state.pendingReview = false;
      openReviewComposer();
    } else {
      $("#resenas").scrollIntoView({ behavior: "smooth" });
    }
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    $("#authSubmit").disabled = false;
  }
});

function updateAuthUI() {
  const signed = Boolean(state.user);
  $("#accountButton").textContent = signed ? state.user.name.split(" ")[0] : "Ingresar";
  $("#authBadge").textContent = signed ? `Sesión iniciada como ${state.user.name}` : "Necesitas una cuenta para calificar";
  $("#authBadge").classList.toggle("signed", signed);
  $("#starInput").disabled = !signed;
  $("#reviewText").disabled = !signed;
  $("#submitReview").disabled = !signed;
  $("#signinPrompt").hidden = signed;
  if (!signed) $("#reviewComposer").hidden = true;
}

$$('[data-rating]').forEach(button => {
  button.addEventListener("click", () => {
    if (!state.user) return openModal();
    state.rating = Number(button.dataset.rating);
    $$('[data-rating]').forEach(star => star.classList.toggle("active", Number(star.dataset.rating) <= state.rating));
    $("#ratingOutput").textContent = `${state.rating} de 5`;
  });
});

$("#reviewForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user) return openModal();
  if (!state.rating) {
    $("#ratingOutput").textContent = "Selecciona al menos 1 estrella";
    return;
  }
  const submit = $("#submitReview");
  submit.disabled = true;
  try {
    await api("/api/reviews", {
      method: "POST",
      body: JSON.stringify({ rating: state.rating, text: $("#reviewText").value.trim() })
    });
    state.rating = 0;
    $("#reviewForm").reset();
    $$('[data-rating]').forEach(star => star.classList.remove("active"));
    $("#ratingOutput").textContent = "Reseña publicada. Puedes actualizarla cuando quieras.";
    await loadReviews();
  } catch (error) {
    $("#ratingOutput").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function renderReviews() {
  const feed = $("#reviewFeed");
  const toggle = $("#toggleReviewsButton");
  if (!state.reviews.length) {
    feed.innerHTML = '<div class="empty-reviews"><span>☆</span><strong>Sé la primera persona en calificar</strong><p>Tu reseña ayuda a mejorar el servicio y genera confianza en la comunidad.</p></div>';
    $("#ratingAverage").textContent = "0.0";
    $("#ratingCount").textContent = "Aún no hay reseñas";
    toggle.hidden = true;
    return;
  }
  const average = state.reviews.reduce((sum, review) => sum + review.rating, 0) / state.reviews.length;
  $("#ratingAverage").textContent = average.toFixed(1);
  $("#ratingCount").textContent = `${state.reviews.length} ${state.reviews.length === 1 ? "reseña" : "reseñas"}`;
  toggle.hidden = state.reviews.length <= 3;
  toggle.textContent = state.showAllReviews ? "Mostrar menos" : `Ver todas las reseñas (${state.reviews.length})`;
  const visibleReviews = state.showAllReviews ? state.reviews : state.reviews.slice(0, 3);
  feed.innerHTML = visibleReviews.map(review => `
    <article class="review-card">
      <div class="review-card-top"><strong>${escapeHTML(review.name)}</strong><span class="review-stars" aria-label="${review.rating} de 5 estrellas">${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}</span></div>
      <p>${escapeHTML(review.text)}</p>
      <time datetime="${review.date}">${new Intl.DateTimeFormat("es-PE", { dateStyle: "long" }).format(new Date(review.date))}</time>
    </article>`).join("");
}

$("#toggleReviewsButton").addEventListener("click", () => {
  state.showAllReviews = !state.showAllReviews;
  renderReviews();
});

$("#writeReviewButton").addEventListener("click", () => {
  if (!state.user) {
    state.pendingReview = true;
    return openModal();
  }
  openReviewComposer();
});

function openReviewComposer() {
  const composer = $("#reviewComposer");
  composer.hidden = false;
  composer.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => $("#reviewText").focus({ preventScroll: true }), 350);
}

$("#closeReviewComposer").addEventListener("click", () => {
  $("#reviewComposer").hidden = true;
  $("#writeReviewButton").focus();
});

async function loadReviews() {
  try {
    const data = await api("/api/reviews");
    state.reviews = data.reviews;
    renderReviews();
  } catch {
    $("#reviewFeed").innerHTML = '<div class="empty-reviews"><span>!</span><strong>No pudimos cargar las reseñas</strong><p>Vuelve a intentarlo en un momento.</p></div>';
  }
}

async function initialize() {
  setAuthMode("register");
  updateStatus();
  try { state.user = (await api("/api/session")).user; } catch { state.user = null; }
  updateAuthUI();
  await loadReviews();
}

initialize();
setInterval(updateStatus, 60000);
