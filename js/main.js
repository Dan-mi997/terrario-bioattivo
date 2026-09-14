document.addEventListener("DOMContentLoaded", () => {
  // 1. Feedback immediato al tocco su display touch
  const interactiveElements = document.querySelectorAll(".nav-card, .back-link");
  interactiveElements.forEach((el) => {
    el.addEventListener("touchstart", () => {}, { passive: true });
  });

  // 2. Indicatore dinamico giorno/notte per l'attività nel terrario
  const currentHour = new Date().getHours();
  const isNight = currentHour >= 20 || currentHour < 6;

  // Se siamo nella home page, personalizziamo il badge in base all'orario
  const statusGrid = document.querySelector(".status-pill-grid");
  if (statusGrid) {
    const timeStatusCard = document.createElement("div");
    timeStatusCard.className = "status-pill";
    
    if (isNight) {
      timeStatusCard.innerHTML = `
        <span class="status-label">Fase Attuale</span>
        <span class="status-val" style="color: #70d6ff;">🌙 Notturna (Attivi)</span>
      `;
    } else {
      timeStatusCard.innerHTML = `
        <span class="status-label">Fase Attuale</span>
        <span class="status-val" style="color: var(--accent-amber);">☀️ Diurna (Nei rifugi)</span>
      `;
    }

    // Trasforma la griglia in 4 riquadri ordinati
    statusGrid.style.gridTemplateColumns = "repeat(2, 1fr)";
    statusGrid.appendChild(timeStatusCard);
  }
});