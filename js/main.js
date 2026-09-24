document.addEventListener("DOMContentLoaded", () => {
  const interactiveElements = document.querySelectorAll(".nav-card, .back-link");
  interactiveElements.forEach((el) => {
    el.addEventListener("touchstart", () => {}, { passive: true });
  });

  calculateCircadianPhaseLazzate();
  // Ricalcola ogni minuto per mantenere aggiornata la fase
  setInterval(calculateCircadianPhaseLazzate, 60000);
});

// Coordinate Lazzate (uniformate)
const LATITUDE = 45.6722;
const LONGITUDE = 9.0833;

// Offset di transizione in minuti rispetto all'evento solare astronomico
// Alba: 60 min centrati (-30 min / +30 min)
// Tramonto: 60 min (-45 min / +15 min)
const DAWN_START_OFFSET = -30;
const DAWN_END_OFFSET   = +30;
const DUSK_START_OFFSET = -45;
const DUSK_END_OFFSET   = +15;

function calculateCircadianPhaseLazzate() {
  const phaseEl = document.getElementById("phase-status");
  const transLabelEl = document.getElementById("transition-label");
  const transTimeEl = document.getElementById("transition-time");

  if (!phaseEl || !transLabelEl || !transTimeEl) return;

  const now = new Date();

  // Calcolo alba e tramonto astronomici di oggi con algoritmo NOAA
  const srToday = calculateNoaaSunEvent(now, LATITUDE, LONGITUDE, true);
  const ssToday = calculateNoaaSunEvent(now, LATITUDE, LONGITUDE, false);

  // Finestre temporali effettive identiche all'ESP32
  const dawnStart = new Date(srToday.getTime() + DAWN_START_OFFSET * 60000);
  const dawnEnd   = new Date(srToday.getTime() + DAWN_END_OFFSET * 60000);
  const duskStart = new Date(ssToday.getTime() + DUSK_START_OFFSET * 60000);
  const duskEnd   = new Date(ssToday.getTime() + DUSK_END_OFFSET * 60000);

  const formatHHMM = (d) =>
    d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

  // 1. FASE ALBA
  if (now >= dawnStart && now < dawnEnd) {
    phaseEl.innerHTML = "🌅 Alba (Transizione)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Fine Alba";
    transTimeEl.textContent = formatHHMM(dawnEnd);
    transTimeEl.style.color = "var(--text-primary)";
  } 
  // 2. FASE DIURNA
  else if (now >= dawnEnd && now < duskStart) {
    phaseEl.innerHTML = "☀️ Diurna (Nei rifugi)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Inizio Tramonto";
    transTimeEl.textContent = formatHHMM(duskStart);
    transTimeEl.style.color = "var(--accent-amber)";
  } 
  // 3. FASE TRAMONTO
  else if (now >= duskStart && now < duskEnd) {
    phaseEl.innerHTML = "🌇 Tramonto (Risveglio)";
    phaseEl.style.color = "var(--accent-amber)";
    transLabelEl.textContent = "Fine Tramonto";
    transTimeEl.textContent = formatHHMM(duskEnd);
    transTimeEl.style.color = "#70d6ff";
  } 
  // 4. FASE NOTTURNA
  else {
    phaseEl.innerHTML = "🌙 Notturna (Attivi)";
    phaseEl.style.color = "#70d6ff";

    let targetDawnStart;
    if (now >= duskEnd) {
      // Se siamo dopo il tramonto, la prossima alba è domani
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const srTomorrow = calculateNoaaSunEvent(tomorrow, LATITUDE, LONGITUDE, true);
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

// Algoritmo astronomico NOAA (trasposizione esatta della funzione C++)
function calculateNoaaSunEvent(date, lat, lon, isSunrise) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // Fuso orario locale in ore (gestisce in automatico ora legale/solare del browser)
  const tzOffsetHours = -date.getTimezoneOffset() / 60;

  const N1 = Math.floor((275 * month) / 9);
  const N2 = Math.floor((month + 9) / 12);
  const N3 = 1 + Math.floor((year - 4 * Math.floor(year / 4) + 2) / 3);
  const N = N1 - N2 * N3 + day - 30;

  const lngHour = lon / 15.0;
  const t = isSunrise ? N + (6.0 - lngHour) / 24.0 : N + (18.0 - lngHour) / 24.0;

  const M = 0.9856 * t - 3.289;

  let L = M + 1.916 * Math.sin((M * Math.PI) / 180.0) + 0.02 * Math.sin((2 * M * Math.PI) / 180.0) + 282.634;
  L = L % 360.0;
  if (L < 0) L += 360.0;

  let RA = (Math.atan(0.91764 * Math.tan((L * Math.PI) / 180.0)) * 180.0) / Math.PI;
  RA = RA % 360.0;
  if (RA < 0) RA += 360.0;

  const Lquadrant = Math.floor(L / 90.0) * 90.0;
  const RAquadrant = Math.floor(RA / 90.0) * 90.0;
  RA = (RA + (Lquadrant - RAquadrant)) / 15.0;

  const sinDec = 0.39782 * Math.sin((L * Math.PI) / 180.0);
  const cosDec = Math.cos(Math.asin(sinDec));

  const cosH =
    (Math.cos((90.833 * Math.PI) / 180.0) - sinDec * Math.sin((lat * Math.PI) / 180.0)) /
    (cosDec * Math.cos((lat * Math.PI) / 180.0));

  if (cosH > 1.0 || cosH < -1.0) return null;

  let H = isSunrise ? 360.0 - (Math.acos(cosH) * 180.0) / Math.PI : (Math.acos(cosH) * 180.0) / Math.PI;
  H = H / 15.0;

  const T = H + RA - 0.06571 * t - 6.622;
  let UT = (T - lngHour) % 24.0;
  if (UT < 0) UT += 24.0;

  let localT = (UT + tzOffsetHours) % 24.0;
  if (localT < 0) localT += 24.0;

  const totalMinutes = Math.round(localT * 60.0);
  const eventDate = new Date(date);
  eventDate.setHours(0, 0, 0, 0);
  eventDate.setMinutes(totalMinutes);
  return eventDate;
}
