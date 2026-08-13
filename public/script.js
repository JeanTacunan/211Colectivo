const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const state = { authMode: "register", rating: 0, user: null, reviews: [], average: 0, total: 0, myReview: null, showAllReviews: false, pendingReview: false, dniProof: null };

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

const modal = $("#authModal");
function openModal() { modal.hidden = false; document.body.classList.add("modal-open"); setTimeout(() => $(state.authMode === "register" ? "#authDni" : "#authEmail").focus(), 20); }
function closeModal(resetPending = true) { modal.hidden = true; document.body.classList.remove("modal-open"); $("#authMessage").textContent = ""; if (resetPending) state.pendingReview = false; }
function resetDni() { state.dniProof = null; $("#authName").value = ""; $("#dniStatus").textContent = ""; $("#dniStatus").classList.remove("error"); }
function setAuthMode(mode) {
  state.authMode = mode;
  $$('[data-auth-tab]').forEach(tab => { const active = tab.dataset.authTab === mode; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); });
  const registering = mode === "register";
  $("#dniFields").hidden = !registering;
  $("#authDni").required = registering;
  $("#authName").required = registering;
  $("#confirmPasswordField").hidden = !registering;
  $("#authPasswordConfirm").required = registering;
  $("#authPassword").autocomplete = registering ? "new-password" : "current-password";
  $("#authSubmit").textContent = registering ? "Crear mi cuenta" : "Ingresar";
  $("#authTitle").textContent = registering ? "Únete a la comunidad" : "Qué bueno verte";
  $("#authMessage").textContent = "";
}

$("#validateDniButton").addEventListener("click", async () => {
  const dni = $("#authDni").value;
  resetDni();
  if (!/^[0-9]{8}$/.test(dni)) { $("#dniStatus").textContent = "El DNI debe contener exactamente 8 dígitos."; $("#dniStatus").classList.add("error"); return; }
  const button = $("#validateDniButton"); button.disabled = true; button.textContent = "Validando…";
  try {
    const data = await api("/api/dni/validate", { method: "POST", body: JSON.stringify({ dni }) });
    state.dniProof = data.proof; $("#authName").value = data.person.nombreCompleto; $("#dniStatus").textContent = "✓ DNI encontrado. Revisa tu nombre y completa el registro.";
  } catch (error) { $("#dniStatus").textContent = error.message; $("#dniStatus").classList.add("error"); }
  finally { button.disabled = false; button.textContent = "Validar DNI"; }
});
$("#authDni").addEventListener("input", event => { event.target.value = event.target.value.replace(/\D/g, "").slice(0, 8); resetDni(); });

$("#accountButton").addEventListener("click", async () => {
  if (!state.user) return openModal();
  if (!confirm(`Sesión iniciada como ${state.user.name}. ¿Quieres cerrar sesión?`)) return;
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } finally { state.user = null; state.myReview = null; updateAuthUI(); await loadReviews(); }
});
$("#signinPrompt").addEventListener("click", openModal);
$$('[data-close-modal]').forEach(element => element.addEventListener("click", () => closeModal()));
$$('[data-auth-tab]').forEach(tab => tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab)));
document.addEventListener("keydown", event => { if (event.key === "Escape" && !modal.hidden) closeModal(); });

$("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.authMode === "register" && !state.dniProof) { $("#authMessage").textContent = "Primero valida tu DNI."; return; }
  const submit = $("#authSubmit"); submit.disabled = true;
  const payload = { email: $("#authEmail").value.trim().toLowerCase(), password: $("#authPassword").value };
  if (state.authMode === "register") Object.assign(payload, { passwordConfirm: $("#authPasswordConfirm").value, proof: state.dniProof });
  try {
    const data = await api(`/api/auth/${state.authMode}`, { method: "POST", body: JSON.stringify(payload) });
    state.user = data.user; $("#authForm").reset(); resetDni(); closeModal(false); updateAuthUI(); await loadReviews();
    if (state.pendingReview) { state.pendingReview = false; openReviewComposer(); } else $("#resenas").scrollIntoView({ behavior: "smooth" });
  } catch (error) { $("#authMessage").textContent = error.message; }
  finally { submit.disabled = false; }
});

function updateAuthUI() {
  const signed = Boolean(state.user);
  $("#accountButton").textContent = signed ? state.user.name.split(" ")[0] : "Ingresar";
  $("#authBadge").textContent = signed ? `Sesión iniciada como ${state.user.name}` : "Necesitas una cuenta para calificar";
  $("#authBadge").classList.toggle("signed", signed);
  $("#starInput").disabled = !signed; $("#reviewText").disabled = !signed; $("#submitReview").disabled = !signed; $("#signinPrompt").hidden = signed;
  if (!signed) $("#reviewComposer").hidden = true;
}
function setRating(rating) { state.rating = rating; $$('[data-rating]').forEach(star => star.classList.toggle("active", Number(star.dataset.rating) <= rating)); $("#ratingOutput").textContent = `${rating} de 5`; }
$$('[data-rating]').forEach(button => button.addEventListener("click", () => state.user ? setRating(Number(button.dataset.rating)) : openModal()));

$("#reviewForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user) return openModal();
  if (!state.rating) { $("#ratingOutput").textContent = "Selecciona al menos 1 estrella"; return; }
  const text = $("#reviewText").value.trim(); const submit = $("#submitReview"); submit.disabled = true;
  try {
    await api(state.myReview ? "/api/reviews/mine" : "/api/reviews", { method: state.myReview ? "PUT" : "POST", body: JSON.stringify({ rating: state.rating, text }) });
    $("#ratingOutput").textContent = state.myReview ? "Reseña actualizada." : "Reseña publicada. Puedes actualizarla cuando quieras."; await loadReviews();
  } catch (error) { $("#ratingOutput").textContent = error.message; }
  finally { submit.disabled = false; }
});

function escapeHTML(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function renderReviews() {
  const feed = $("#reviewFeed"); const toggle = $("#toggleReviewsButton");
  $("#ratingAverage").textContent = state.average.toFixed(1); $("#ratingCount").textContent = state.total ? `${state.total} ${state.total === 1 ? "reseña" : "reseñas"}` : "Aún no hay reseñas";
  if (!state.reviews.length) { feed.innerHTML = '<div class="empty-reviews"><span>☆</span><strong>Sé la primera persona en calificar</strong><p>Tu reseña ayuda a mejorar el servicio y genera confianza en la comunidad.</p></div>'; toggle.hidden = true; return; }
  toggle.hidden = state.reviews.length <= 3; toggle.textContent = state.showAllReviews ? "Mostrar menos" : `Ver todas las reseñas (${state.reviews.length})`;
  const visible = state.showAllReviews ? state.reviews : state.reviews.slice(0, 3);
  feed.innerHTML = visible.map(review => `<article class="review-card"><div class="review-card-top"><strong>${escapeHTML(review.name)}</strong><span class="review-stars" aria-label="${review.rating} de 5 estrellas">${"★".repeat(review.rating)}${"☆".repeat(5-review.rating)}</span></div><p>${escapeHTML(review.text)}</p><time datetime="${review.date}">${new Intl.DateTimeFormat("es-PE", { dateStyle: "long" }).format(new Date(review.date))}</time></article>`).join("");
}
$("#toggleReviewsButton").addEventListener("click", () => { state.showAllReviews = !state.showAllReviews; renderReviews(); });
$("#writeReviewButton").addEventListener("click", () => { if (!state.user) { state.pendingReview = true; return openModal(); } openReviewComposer(); });
function openReviewComposer() { $("#reviewComposer").hidden = false; if (state.myReview) { $("#reviewText").value = state.myReview.text; setRating(state.myReview.rating); $("#submitReview").textContent = "Actualizar reseña"; } else { $("#reviewText").value = ""; setRating(0); $("#submitReview").textContent = "Publicar reseña"; } $("#reviewComposer").scrollIntoView({ behavior: "smooth", block: "center" }); }
$("#closeReviewComposer").addEventListener("click", () => { $("#reviewComposer").hidden = true; $("#writeReviewButton").focus(); });
async function loadReviews() { try { const data = await api("/api/reviews"); Object.assign(state, { reviews: data.reviews || [], average: data.average || 0, total: data.total || 0, myReview: data.myReview || null }); renderReviews(); } catch { $("#reviewFeed").innerHTML = '<div class="empty-reviews"><span>!</span><strong>No pudimos cargar las reseñas</strong><p>Vuelve a intentarlo en un momento.</p></div>'; } }
async function initialize() { setAuthMode("register"); updateStatus(); try { state.user = (await api("/api/auth/me")).user; } catch { state.user = null; } updateAuthUI(); await loadReviews(); }
initialize(); setInterval(updateStatus, 60000);
