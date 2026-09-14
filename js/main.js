document.addEventListener("DOMContentLoaded", () => {
  // 1. Feedback immediato al tocco per display touch
  const interactiveElements = document.querySelectorAll(".nav-card, .back-link");
  interactiveElements.forEach((el) => {
    el.addEventListener("touchstart", () => {}, { passive: true });
  });

  // 2. Calcolo astronomico a 4 fasi (Alba, Giorno, Tramonto, Notte) per Lazzate
  calculateCircadianPhaseLazzate();
});

function calculateCircadianPhaseLazzate() {
  const phaseEl = document.getElementById("phase-status");
  const transLabelEl = document.getElementById("transition-label");
  const transTimeEl = document.getElementById("transition-time");

  if (!phaseEl || !transLabelEl || !transTimeEl) return;

  const lat = 45.672; // Lazzate (MB)
  const lon = 9.082;
  const now = new Date();

  // Durata della rampa LED arancione (in minuti)
  const TRANSITION_DURATION_MIN = 45;

  const times = getSunTimes(now, lat, lon);
  const sunrise = times.sunrise;
  const sunset = times.sunset;

  // Intervallo Alba: da sunrise a sunrise + 45 min
  const sunriseEnd = new Date(sunrise.getTime() + TRANSITION_DURATION_MIN * 60000);

  // Intervallo Tramonto: da sunset - 45 min a sunset
  const sunsetStart = new Date(sunset.getTime() - TRANSITION_DURATION_MIN * 60000);

  const formatHHMM = (d) =>
    d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

  // Determinazione delle 4 fasi
  if (now >= sunrise && now < sunriseEnd) {
    // 1. FASE ALBA
    phaseEl.innerHTML = "🌅 Alba (Transizione)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Fase Diurna alle";
    transTimeEl.textContent = formatHHMM(sunriseEnd);
    transTimeEl.style.color = "var(--text-primary)";
  } else if (now >= sunriseEnd && now < sunsetStart) {
    // 2. FASE DIURNA
    phaseEl.innerHTML = "☀️ Diurna (Nei rifugi)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Tramonto LED alle";
    transTimeEl.textContent = formatHHMM(sunsetStart);
    transTimeEl.style.color = "var(--accent-amber)";
  } else if (now >= sunsetStart && now < sunset) {
    // 3. FASE TRAMONTO
    phaseEl.innerHTML = "🌇 Tramonto (Risveglio)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Fase Notturna alle";
    transTimeEl.textContent = formatHHMM(sunset);
    transTimeEl.style.color = "#70d6ff";
  } else {
    // 4. FASE NOTTURNA
    phaseEl.innerHTML = "🌙 Notturna (Attivi)";
    phaseEl.style.color = "#70d6ff";

    let nextSunrise = sunrise;
    if (now >= sunset) {
      // Se siamo passati dal tramonto odierno, la prossima alba è domani
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      nextSunrise = getSunTimes(tomorrow, lat, lon).sunrise;
    }

    transLabelEl.textContent = "Alba LED alle";
    transTimeEl.textContent = formatHHMM(nextSunrise);
    transTimeEl.style.color = "var(--accent-amber)";
  }
}

// Algoritmo solare
function getSunTimes(date, lat, lon) {
  const startOfYear = new Date(date.getFullYear(), 0, 0);
  const diff = date - startOfYear;
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));

  const declination =
    23.45 * Math.sin(((360 / 365) * (dayOfYear - 81) * Math.PI) / 180);

  const b = ((360 / 365) * (dayOfYear - 81) * Math.PI) / 180;
  const eot =
    9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);

  const rad = Math.PI / 180;
  const latRad = lat * rad;
  const decRad = declination * rad;
  const cosH =
    (Math.sin(-0.83 * rad) - Math.sin(latRad) * Math.sin(decRad)) /
    (Math.cos(latRad) * Math.cos(decRad));

  const clampedCosH = Math.max(-1, Math.min(1, cosH));
  const hourAngle = (Math.acos(clampedCosH) * 180) / Math.PI;

  const solarNoonMinutes = 720 - 4 * lon - eot;
  const sunriseMinutes = solarNoonMinutes - hourAngle * 4;
  const sunsetMinutes = solarNoonMinutes + hourAngle * 4;

  const timezoneOffsetMinutes = -date.getTimezoneOffset();

  const sunriseDate = new Date(date);
  sunriseDate.setHours(0, 0, 0, 0);
  sunriseDate.setMinutes(sunriseMinutes + timezoneOffsetMinutes);

  const sunsetDate = new Date(date);
  sunsetDate.setHours(0, 0, 0, 0);
  sunsetDate.setMinutes(sunsetMinutes + timezoneOffsetMinutes);

  return { sunrise: sunriseDate, sunset: sunsetDate };
}
