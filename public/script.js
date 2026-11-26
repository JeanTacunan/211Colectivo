const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const state = { rating: 0, hoverRating: 0, reviews: [], average: 0, total: 0, myReview: null, showAllReviews: false };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "No se pudo completar la solicitud.");
  return data;
}

function limaNow() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Lima", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type)?.value;
  return { day: value("weekday"), minutes: Number(value("hour")) * 60 + Number(value("minute")) };
}
function updateStatus() {
  const { day, minutes } = limaNow();
  const active = (["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day) && minutes >= 1110) || (day === "Sat" && minutes >= 1080) || (day === "Sun" && (minutes <= 120 || minutes >= 1080));
  [["#statusDot", "#statusText"], ["#heroStatusDot", "#heroStatusText"], ["#mobileStatusDot", "#mobileStatusText"]].forEach(([dot]) => $(dot)?.classList.toggle("on", active));
  $("#statusText").textContent = active ? "En servicio ahora" : "Fuera de horario";
  $("#statusDetail").textContent = active ? "Disponible en la ruta · Hora de Perú" : "Revisa el próximo turno · Hora de Perú";
  $("#heroStatusText").textContent = active ? "Disponible ahora" : "Fuera de horario";
  $("#mobileStatusText").textContent = active ? "Disponible · Horario" : "Ver horario";
}

const observer = new IntersectionObserver(entries => entries.forEach(entry => entry.isIntersecting && entry.target.classList.add("visible")), { threshold: .12 });
$$('.reveal').forEach(element => observer.observe(element));
$(".menu-toggle").addEventListener("click", event => { const open = $("#mainNav").classList.toggle("open"); event.currentTarget.setAttribute("aria-expanded", String(open)); });
$$('#mainNav a').forEach(link => link.addEventListener("click", () => { $("#mainNav").classList.remove("open"); $(".menu-toggle").setAttribute("aria-expanded", "false"); }));

function renderStars() {
  const visibleRating = state.hoverRating || state.rating;
  $$('[data-rating]').forEach(star => {
    const value = Number(star.dataset.rating);
    star.classList.toggle("active", value <= visibleRating);
    star.classList.toggle("preview", state.hoverRating > 0 && value <= state.hoverRating);
  });
}
function setRating(rating) {
  state.rating = rating;
  state.hoverRating = 0;
  renderStars();
  $("#ratingOutput").textContent = `${rating} de 5`;
}
$$('[data-rating]').forEach(button => {
  const value = Number(button.dataset.rating);
  button.addEventListener("mouseenter", () => {
    state.hoverRating = value;
    renderStars();
  });
  button.addEventListener("mouseleave", () => {
    state.hoverRating = 0;
    renderStars();
  });
  button.addEventListener("focus", () => {
    state.hoverRating = value;
    renderStars();
  });
  button.addEventListener("blur", () => {
    state.hoverRating = 0;
    renderStars();
  });
  button.addEventListener("click", () => setRating(value));
});

$("#reviewForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.rating) { $("#ratingOutput").textContent = "Selecciona al menos 1 estrella"; return; }
  const text = $("#reviewText").value.trim();
  const name = $("#reviewName").value.trim() || "Anónimo";
  const submit = $("#submitReview"); submit.disabled = true;
  $("#reviewConfirmation").hidden = true;
  $("#ratingOutput").textContent = "Guardando reseña…";
  try {
    const isUpdate = Boolean(state.myReview);
    await api("/api/reviews", { method: "POST", body: JSON.stringify({ rating: state.rating, text, name }) });
    state.showAllReviews = true;
    const loaded = await loadReviews();
    $("#reviewComposer").hidden = true;
    $("#reviewConfirmationText").textContent = isUpdate ? "¡Tu reseña se actualizó correctamente!" : "¡Tu reseña se publicó correctamente!";
    $("#viewSavedReview").hidden = !loaded || !state.myReview;
    if (!loaded) $("#reviewConfirmationText").textContent += " Se guardó, pero no pudimos actualizar la lista. Recarga la página para verla.";
    $("#reviewConfirmation").hidden = false;
    $("#reviewConfirmation").focus({ preventScroll: true });
    $("#reviewConfirmation").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) { $("#ratingOutput").textContent = error.message; }
  finally { submit.disabled = false; }
});

function escapeHTML(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function formatDate(dateString) {
  if (!dateString) return "";
  try {
    const isoString = dateString.includes("T") ? dateString : dateString.replace(" ", "T") + "Z";
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("es-PE", { dateStyle: "long" }).format(date);
  } catch {
    return "";
  }
}
function renderReviews() {
  const feed = $("#reviewFeed"); const toggle = $("#toggleReviewsButton");
  const ratingAverage = $("#ratingAverage");
  ratingAverage.textContent = state.average.toFixed(1);
  ratingAverage.classList.remove("score-good", "score-warning", "score-bad");
  if (state.average >= 4.5) ratingAverage.classList.add("score-good");
  else if (state.average >= 3.5) ratingAverage.classList.add("score-warning");
  else ratingAverage.classList.add("score-bad");
  $("#ratingCount").textContent = state.total ? `${state.total} ${state.total === 1 ? "reseña" : "reseñas"}` : "Aún no hay reseñas";
  if (state.myReview) $("#writeReviewButton").textContent = "Editar mi reseña";
  else $("#writeReviewButton").textContent = "Escribir una reseña";
  if (!state.reviews.length) { feed.innerHTML = '<div class="empty-reviews"><span>☆</span><strong>Sé la primera persona en calificar</strong><p>Tu reseña ayuda a mejorar el servicio y genera confianza en la comunidad.</p></div>'; toggle.hidden = true; return; }
  toggle.hidden = state.reviews.length <= 3; toggle.textContent = state.showAllReviews ? "Mostrar menos" : `Ver todas las reseñas (${state.reviews.length})`;
  const visible = state.showAllReviews ? state.reviews : state.reviews.slice(0, 3);
  feed.innerHTML = visible.map(review => `<article class="review-card${review.mine ? " my-review" : ""}"><div class="review-card-top"><strong>${escapeHTML(review.name)}${review.mine ? " (Tú)" : ""}</strong><span class="review-stars" aria-label="${review.rating} de 5 estrellas">${"★".repeat(review.rating)}${"☆".repeat(5-review.rating)}</span></div><p>${escapeHTML(review.text)}</p><time datetime="${review.date}">${formatDate(review.date)}</time></article>`).join("");
}
$("#toggleReviewsButton").addEventListener("click", () => { state.showAllReviews = !state.showAllReviews; renderReviews(); });
$("#writeReviewButton").addEventListener("click", () => openReviewComposer());
function openReviewComposer() {
  $("#reviewConfirmation").hidden = true;
  $("#reviewComposer").hidden = false;
  if (state.myReview) {
    $("#reviewText").value = state.myReview.text || "";
    $("#reviewName").value = state.myReview.name || "";
    setRating(state.myReview.rating || 0);
    $("#submitReview").textContent = "Actualizar reseña";
  } else {
    $("#reviewText").value = "";
    $("#reviewName").value = "";
    setRating(0);
    $("#submitReview").textContent = "Publicar reseña";
  }
  $("#reviewComposer").scrollIntoView({ behavior: "smooth", block: "center" });
}
$("#closeReviewComposer").addEventListener("click", () => { $("#reviewComposer").hidden = true; $("#writeReviewButton").focus(); });
$("#viewSavedReview").addEventListener("click", () => {
  const review = $(".my-review");
  if (review) {
    review.setAttribute("tabindex", "-1");
    review.focus({ preventScroll: true });
    review.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});
async function loadReviews() { try { const data = await api("/api/reviews"); Object.assign(state, { reviews: data.reviews || [], average: data.average || 0, total: data.total || 0, myReview: data.myReview || null }); renderReviews(); return true; } catch { $("#reviewFeed").innerHTML = '<div class="empty-reviews"><span>!</span><strong>No pudimos cargar las reseñas</strong><p>Vuelve a intentarlo en un momento.</p></div>'; return false; } }
async function initialize() { updateStatus(); await Promise.all([loadReviews(), loadAccount()]); }


let account = null;
let authMode = "login";
const authDialog = $("#authDialog");
function renderAccount() {
  const signedIn = Boolean(account?.phone);
  $("#authSignedOut").hidden = signedIn;
  $("#authSignedIn").hidden = !signedIn;
  $("#accountButton").textContent = signedIn ? "Mi cuenta · Conectado" : "Mi cuenta";
  $("#accountName").textContent = account?.name || "";
}
async function loadAccount() {
  try { account = (await api("/api/auth/me")).user; } catch { account = null; }
  renderAccount();
}
function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  $("#registerFields").hidden = !registering;
  $("#registerFields").disabled = !registering;
  $("#loginTab").classList.toggle("active", !registering);
  $("#registerTab").classList.toggle("active", registering);
  $("#loginTab").setAttribute("aria-pressed", String(!registering));
  $("#registerTab").setAttribute("aria-pressed", String(registering));
  $("#authSubmit").textContent = registering ? "Crear cuenta" : "Iniciar sesión";
  $("#authPassword").autocomplete = registering ? "new-password" : "current-password";
  $("#authMessage").textContent = "";
}
$("#accountButton").addEventListener("click", () => { renderAccount(); authDialog.showModal(); });
$("#closeAuth").addEventListener("click", () => authDialog.close());
authDialog.addEventListener("close", () => {
  $("#authPassword").value = "";
  $("#authPassword").type = "password";
  $("#togglePassword").textContent = "Mostrar";
  $("#togglePassword").setAttribute("aria-pressed", "false");
});
$("#loginTab").addEventListener("click", () => setAuthMode("login"));
$("#registerTab").addEventListener("click", () => setAuthMode("register"));
$("#togglePassword").addEventListener("click", () => {
  const visible = $("#authPassword").type === "password";
  $("#authPassword").type = visible ? "text" : "password";
  $("#togglePassword").textContent = visible ? "Ocultar" : "Mostrar";
  $("#togglePassword").setAttribute("aria-pressed", String(visible));
});
$("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget));
  const controls = [$("#authSubmit"), $("#loginTab"), $("#registerTab")];
  controls.forEach(button => button.disabled = true);
  $("#authMessage").textContent = "Un momento…";
  try {
    const data = await api("/api/auth/" + authMode, { method: "POST", body: JSON.stringify(payload) });
    account = data.user;
    $("#authForm").reset();
    $("#authMessage").textContent = "";
    $("#reviewComposer").hidden = true;
    renderAccount();
    await loadReviews();
  } catch (error) { $("#authMessage").textContent = error.message; }
  finally { controls.forEach(button => button.disabled = false); }
});
$("#logoutButton").addEventListener("click", async () => {
  $("#logoutButton").disabled = true;
  $("#logoutMessage").textContent = "";
  try {
    await api("/api/auth/logout", { method: "POST" });
    account = null;
    $("#reviewComposer").hidden = true;
    renderAccount();
    setAuthMode("login");
    await loadReviews();
  } catch (error) { $("#logoutMessage").textContent = error.message; }
  finally { $("#logoutButton").disabled = false; }
});
initialize(); setInterval(updateStatus, 60000);
