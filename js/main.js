document.addEventListener("DOMContentLoaded", () => {
  const interactiveElements = document.querySelectorAll(".nav-card, .back-link");
  interactiveElements.forEach((el) => {
    el.addEventListener("touchstart", () => {}, { passive: true });
  });

  calculateCircadianPhaseLazzate();
  // Ricalcola ogni minuto per mantenere aggiornata la fase
  setInterval(calculateCircadianPhaseLazzate, 60000);
});

// Coordinate Lazzate (uniformate esattamente al C++)
const LATITUDE = 45.674;
const LONGITUDE = 9.082;

// Offset di transizione in minuti rispetto all'evento solare astronomico
// Uniformati all'ESP32: Alba e Tramonto sono blocchi da 60 min centrati (-30 / +30)
const DAWN_START_OFFSET = -30;
const DAWN_END_OFFSET   = 30;
const DUSK_START_OFFSET = -30;
const DUSK_END_OFFSET   = 30;

function calculateCircadianPhaseLazzate() {
  const phaseEl = document.getElementById("phase-status");
  const transLabelEl = document.getElementById("transition-label");
  const transTimeEl = document.getElementById("transition-time");

  if (!phaseEl || !transLabelEl || !transTimeEl) return;

  const now = new Date();

  // Calcolo alba e tramonto di oggi con l'algoritmo semplificato dell'ESP32
  const srToday = calculateEsp32SunEvent(now, LATITUDE, LONGITUDE, true);
  const ssToday = calculateEsp32SunEvent(now, LATITUDE, LONGITUDE, false);

  // Finestre temporali effettive identiche all'ESP32
  const dawnStart = new Date(srToday.getTime() + DAWN_START_OFFSET * 60000);
  const dawnEnd   = new Date(srToday.getTime() + DAWN_END_OFFSET * 60000);
  const duskStart = new Date(ssToday.getTime() + DUSK_START_OFFSET * 60000);
  const duskEnd   = new Date(ssToday.getTime() + DUSK_END_OFFSET * 60000);

  const formatHHMM = (d) =>
    d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

  // 1. FASE ALBA (ESP32 Phase 1)
  if (now >= dawnStart && now < dawnEnd) {
    phaseEl.innerHTML = "🌅 Alba (Transizione)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Fine Alba";
    transTimeEl.textContent = formatHHMM(dawnEnd);
    transTimeEl.style.color = "var(--text-primary)";
  } 
  // 2. FASE DIURNA (ESP32 Phase 2)
  else if (now >= dawnEnd && now < duskStart) {
    phaseEl.innerHTML = "☀️ Diurna (Nei rifugi)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Inizio Tramonto";
    transTimeEl.textContent = formatHHMM(duskStart);
    transTimeEl.style.color = "var(--accent-amber)";
  } 
  // 3. FASE TRAMONTO (ESP32 Phase 3)
  else if (now >= duskStart && now < duskEnd) {
    phaseEl.innerHTML = "🌇 Tramonto (Risveglio)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Fine Tramonto";
    transTimeEl.textContent = formatHHMM(duskEnd);
    transTimeEl.style.color = "#70d6ff";
  } 
  // 4. FASE NOTTURNA (ESP32 Phase 0)
  else {
    phaseEl.innerHTML = "🌙 Notturna (Attivi)";
    phaseEl.style.color = "#70d6ff";

    let targetDawnStart;
    if (now >= duskEnd) {
      // Se siamo dopo il tramonto, la prossima alba è domani
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const srTomorrow = calculateEsp32SunEvent(tomorrow, LATITUDE, LONGITUDE, true);
      targetDawnStart = new Date(srTomorrow.getTime() + DAWN_START_OFFSET * 60000);
    } else {
      // Se siamo tra mezzanotte e l'inizio dell'alba di oggi
      targetDawnStart = dawnStart;
    }

    transLabelEl.textContent = "Inizio Alba";
    transTimeEl.textContent = formatHHMM(targetDawnStart);
    transTimeEl.style.color = "var(--accent-amber)";
  }
}

// Algoritmo astronomico (trasposizione esatta della funzione getSolarTimes in C++)
function calculateEsp32SunEvent(date, lat, lon, isSunrise) {
  // In C++, timeinfo->tm_yday rappresenta i giorni trascorsi dal 1° Gennaio (0-365)
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const diffTime = date.getTime() - startOfYear.getTime();
  const tm_yday = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  const PI = Math.PI;
  
  const declination = -23.44 * Math.cos((360.0 / 365.24) * (tm_yday + 10) * PI / 180.0);
  const radLat = lat * PI / 180.0;
  const radDec = declination * PI / 180.0;
  
  let cosH = (Math.sin(-0.83 * PI / 180.0) - Math.sin(radLat) * Math.sin(radDec)) / (Math.cos(radLat) * Math.cos(radDec));
  
  // Funzione constrain() dell'ESP32
  if (cosH < -1.0) cosH = -1.0;
  if (cosH > 1.0) cosH = 1.0;
  
  const h = Math.acos(cosH) * 180.0 / PI;
  const halfDay = h / 15.0;
  
  const solarNoonUTC = 12.0 - (lon / 15.0);
  const srUTC = solarNoonUTC - halfDay;
  const ssUTC = solarNoonUTC + halfDay;

  // L'ESP32 usa "1 + (isdst ? 1 : 0)". In JS otteniamo lo stesso risultato usando il getTimezoneOffset locale
  const utcOffset = -date.getTimezoneOffset() / 60.0;
  
  const targetUTC = isSunrise ? srUTC : ssUTC;
  
  // Calcolo dei minuti totali arrotondati come sull'hardware
  const totalMinutes = Math.round((targetUTC + utcOffset) * 60.0);
  
  const eventDate = new Date(date);
  eventDate.setHours(0, 0, 0, 0);
  eventDate.setMinutes(totalMinutes);
  
  return eventDate;
}
