# 🦎 Bioactive Terrarium Controller — Architettura Tecnica & Codice Sorgente

Documentazione ingegneristica, architettura hardware/software, pipeline dati BI e codice sorgente completo per la centralina basata su **ESP32** dedicata alla gestione del terrario bioattivo (*Lazzate, MB*).

Nota: sono state fatte piccole modifiche al codice. Questo documento, pur valido, è leggermente obsoleto. La modifica più importante, l'indirizzo IP è fissato tramite DCHP e non più dal codice.

---

## Indice
1. [Mappatura Hardware & Pinout](#1-mappatura-hardware--pinout)
2. [Scelte Architetturali & Rationale Ingegneristico](#2-scelte-architetturali--rationale-ingegneristico)
3. [Motore Circadiano Astronomico (Lazzate)](#3-motore-circadiano-astronomico-lazzate)
4. [Pipeline Telemetria: Firebase RTDB & Power Query (ETL)](#4-pipeline-telemetria-firebase-rtdb--power-query-etl)
5. [Guida al Flashing & Troubleshooting OTA](#5-guida-al-flashing--troubleshooting-ota)
6. [Codice Sorgente Completo (`TerrarioController.ino`)](#6-codice-sorgente-completo-terrariocontrollerino)

---

## 1. Mappatura Hardware & Pinout

Il sistema utilizza un modulo **ESP32 Dev Module** configurato con due bus I2C hardware fisicamente separati e un canale digitale ad alta velocità per il pilotaggio della striscia LED indirizzabile SK6812 RGBW (36 LED).

| Periferica | Segnale Logico | Pin ESP32 | Note Tecniche |
| :--- | :--- | :--- | :--- |
| **Striscia LED SK6812 RGBW** | `DATA IN` | **GPIO 4 (`D4`)** | Protocollo 800 kHz (`NEO_GRBW`), 36 pixel |
| **Sensore BME280 — Volta** | `SDA` (Data) | **GPIO 21 (`D21`)** | Bus I2C Hardware 0 (`I2Cone`) — Zona aerea |
| **Sensore BME280 — Volta** | `SCL` (Clock) | **GPIO 22 (`D22`)** | Bus I2C Hardware 0 (`I2Cone`) — Zona aerea |
| **Sensore BME280 — Tana** | `SDA` (Data) | **GPIO 18 (`D18`)** | Bus I2C Hardware 1 (`I2Ctwo`) — Zona ipogea |
| **Sensore BME280 — Tana** | `SCL` (Clock) | **GPIO 19 (`D19`)** | Bus I2C Hardware 1 (`I2Ctwo`) — Zona ipogea |

---

## 2. Scelte Architetturali & Rationale Ingegneristico

### 2.1. Downgrade a ESP32 Arduino Core `2.0.17`
Il firmware è progettato per essere compilato specificamente con la versione **2.0.17** dell'ESP32 Arduino Core (basata su **ESP-IDF v4.4.7**), evitando le release 3.x (basate su ESP-IDF v5.x).
* **Stabilità dello Stack Asincrono:** Le librerie `AsyncTCP` ed `ESPAsyncWebServer` fanno affidamento sulle primitive di sincronizzazione FreeRTOS e lwIP di ESP-IDF v4. Nel Core 3.x le modifiche alle firme delle API causano errori di compilazione o crash a runtime (`Guru Meditation Error` / `LoadStoreError`) sotto traffico HTTP concorrente.
* **Coesistenza RMT e Wi-Fi:** Nel Core 2.0.17 la gestione degli interrupt durante la generazione del segnale a 800 kHz per i LED RGBW convive senza conflitti con il task Wi-Fi su Core 0, garantendo un funzionamento continuo 24/7.

### 2.2. Doppio Bus I2C Fisico (`TwoWire(0)` e `TwoWire(1)`)
Invece di collegare entrambi i sensori BME280 in parallelo sullo stesso bus cambiando l'indirizzo hardware (`0x76` / `0x77`), vengono istanziati i due controller I2C fisici dell'ESP32 su coppie di pin indipendenti:
* **Tolleranza ai guasti (Fault Isolation):** Il sensore posto nella *Tana* opera in un ambiente con umidità relativa prossima alla saturazione (>90%). Se la condensa dovesse causare una caduta di tensione o un blocco della linea `SDA/SCL` del bus ipogeo, il bus della *Volta* continuerebbe a funzionare in modo del tutto isolato senza bloccare l'esecuzione del firmware.
* **Indipendenza dagli indirizzi:** Entrambi i sensori possono mantenere l'indirizzo di fabbrica `0x76` senza conflitti di indirizzamento.

### 2.3. Strategia Anti-Autoriscaldamento (*Anti Self-Heating*)
I sensori Bosch BME280 soffrono di autoriscaldamento interno se interrogati continuamente (es. una volta al secondo): il passaggio di corrente nel die riscalda il sensore di **+0.5 °C / +1.5 °C**, falsando di conseguenza anche il calcolo dell'umidità relativa (che risulta sottostimata).
* **Campionamento programmato:** Il firmware mantiene i sensori completamente a riposo e li interroga **solo due volte all'ora, esattamente ai minuti `15` e `45`** (oltre che su eventuale richiesta di test manuale dall'interfaccia web).
* In questo modo la misura riflette sempre il reale equilibrio termico ed igrometrico del terrario.

### 2.4. Disaccoppiamento Thread-Safe (Web Server vs NeoPixel) & Protezione OTA
Chiamare `strip.show()` direttamente dentro le callback HTTP di `ESPAsyncWebServer` causa il riavvio dell'ESP32 (Watchdog Reset), poiché `AsyncWebServer` opera in un task background mentre `Adafruit_NeoPixel` disabilita gli interrupt per rispettare le tempistiche sub-microsecondo dei LED.
* **Pattern Producer-Consumer:** Le rotte HTTP (`/api/bulk`, `/api/dimmer`, `/api/anim`, `/api/auto`) modificano esclusivamente gli array in RAM (`ledBuffer[36][4]`) e alzano il flag `ledsNeedUpdate = true`.
* **Rendering nel Loop a 50 FPS:** L'invio fisico dei dati sul pin `D4` avviene unicamente nel `loop()` principale su Core 1, limitato a un massimo di 50 frame al secondo (ogni 20 ms).
* **Dimming non distruttivo in virgola mobile:** `strip.setBrightness()` è fissato a `255` nel `setup()`. La luminosità generale (`masterBrightness`) viene applicata matematicamente in fase di rendering senza alterare i valori RGBW salvati in `ledBuffer`.
* **Sospensione durante OTA (`isOtaUpdating`):** All'avvio di un caricamento firmware via Wi-Fi (`ArduinoOTA.onStart`), il motore grafico LED viene messo in pausa. Questo impedisce che la disabilitazione degli interrupt di `strip.show()` faccia perdere pacchetti TCP durante il trasferimento dell'immagine binaria.

---

## 3. Motore Circadiano Astronomico (Lazzate)

La centralina integra un algoritmo astronomico autonomo in C++ tarato sulle coordinate geografiche di **Lazzate (Latitudine `45.674° N`, Longitudine `9.082° E`)**:

1. **Calcolo Giornaliero di Alba e Tramonto:** Partendo dal giorno dell'anno (`tm_yday`), il microcontrollore calcola la declinazione solare e l'angolo orario, determinando il minuto esatto di alba (`srMin`) e tramonto (`ssMin`) per la giornata corrente.
2. **Gestione Automatica Ora Solare / Ora Legale:** Tramite la regola POSIX `CET-1CEST,M3.5.0,M10.5.0/3`, l'ESP32 applica automaticamente l'offset UTC+1 in inverno e UTC+2 in estate.
3. **Sincronizzazione Oraria Ibrida (NTP + Browser Fallback):** All'avvio l'ESP32 contatta i server NTP (`pool.ntp.org`, `time.google.com`). Qualora la risposta NTP tardasse ad arrivare, la prima apertura della Web App sincronizza istantaneamente l'orologio interno (`settimeofday`) usando il timestamp Unix del dispositivo client.
4. **Fasi Fotoperiodiche (Modalità Default):**
   * **Notte (`Ora < Alba - 30m` oppure `Ora >= Tramonto + 30m`):** Spegnimento totale (`R:0, G:0, B:0, W:0`).
   * **Finestra d'Alba (`da Alba - 30m a Alba + 30m`, 60 min):** Sfumatura progressiva dal buio all'ambra calda (`255, 60, 0, 10`) nei primi 30 minuti, e dall'ambra alla luce diurna nei successivi 30 minuti.
   * **Giorno (`da Alba + 30m a Tramonto - 30m`):** Spettro diurno bianco pieno bilanciato per la crescita della flora (`R:100, G:120, B:80, W:255`).
   * **Finestra di Tramonto (`da Tramonto - 30m a Tramonto + 30m`, 60 min):** Transizione inversa dalla luce diurna al rosso/ambra crepuscolare, fino al buio completo.
5. **Override Manuale e Ripristino Istantaneo:** Qualsiasi azione di disegno o animazione nella Web App sospende il ciclo automatico passando in *Modalità Manuale*. Premendo il pulsante **Ciclo Naturale**, la coda manuale viene cancellata e l'ESP32 ricalcola e applica all'istante lo stato luminoso previsto per quell'esatto minuto della giornata.

---

## 4. Pipeline Telemetria: Firebase RTDB & Power Query (ETL)

Ad ogni rilevazione (minuti `15` e `45`, o test manuale), l'ESP32 apre una connessione HTTPS sicura (`WiFiClientSecure` con `setInsecure()` e supporto ai redirect HTTP 307 tipici della regione `europe-west1`) ed esegue una chiamata `PUT` verso:

```text
[https://terrario-lazzate-default-rtdb.europe-west1.firebasedatabase.app/telemetria/](https://terrario-lazzate-default-rtdb.europe-west1.firebasedatabase.app/telemetria/)<timestamp>.json
```

Se la connessione Wi-Fi o Internet è assente, il pacchetto viene salvato in un buffer circolare in RAM (`offlineBuffer`, fino a 50 record) e inviato automaticamente non appena la connessione torna disponibile.

### Script Power Query (Linguaggio M) per Power BI / Excel
Per importare i dati storici da Firebase direttamente in **Power BI** o **Excel** (*Recupera Dati -> Da Web -> Editor Avanzato*):

```powerquery
let
    // 1. Connessione all'endpoint REST JSON di Firebase RTDB
    Origine = Json.Document(Web.Contents("[https://terrario-lazzate-default-rtdb.europe-west1.firebasedatabase.app/telemetria.json](https://terrario-lazzate-default-rtdb.europe-west1.firebasedatabase.app/telemetria.json)")),
    
    // 2. Conversione del dizionario di record in Tabella
    TabellaRecord = Record.ToTable(Origine),
    
    // 3. Espansione delle colonne telemetriche
    ColonneEspande = Table.ExpandRecordColumn(TabellaRecord, "Value", 
        {"timestamp", "volta_t", "volta_ur", "tana_t", "tana_ur"}, 
        {"timestamp", "volta_t", "volta_ur", "tana_t", "tana_ur"}
    ),
    
    // 4. Rimozione della chiave testuale ridondante
    ColonneRimosse = Table.RemoveColumns(ColonneEspande, {"Name"}),
    
    // 5. Conversione del Timestamp Unix (UTC) nel fuso orario locale
    AggiuntaDataOraUTC = Table.AddColumn(ColonneRimosse, "DataOra_UTC", each #datetimezone(1970, 1, 1, 0, 0, 0, 0, 0) + #duration(0, 0, 0, [timestamp])),
    AggiuntaDataOraLocale = Table.AddColumn(AggiuntaDataOraUTC, "DataOra", each DateTimeZone.RemoveZone(DateTimeZone.ToLocal([DataOra_UTC]))),
    RimuoviColonnaUTC = Table.RemoveColumns(AggiuntaDataOraLocale, {"DataOra_UTC"}),
    
    // 6. Tipizzazione forte delle colonne per il Data Model
    TipoDatiImpostato = Table.TransformColumnTypes(RimuoviColonnaUTC, {
        {"timestamp", Int64.Type},
        {"volta_t", type number},
        {"volta_ur", type number},
        {"tana_t", type number},
        {"tana_ur", type number},
        {"DataOra", type datetime}
    }),
    
    // 7. Ordinamento cronologico
    Ordinato = Table.Sort(TipoDatiImpostato,{{"timestamp", Order.Ascending}})
in
    Ordinato
```

---

## 5. Guida al Flashing & Troubleshooting OTA

### Parametri Arduino IDE
* **Scheda:** `ESP32 Dev Module`
* **Versione Core:** `esp32 by Espressif Systems v2.0.17`
* **Partition Scheme:** `Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)` (consigliato per avere ampio margine per lo sketch e il doppio slot OTA).

### Risoluzione Problemi Comuni
1. **`Authenticating...OK` seguito da `[ERROR]: No response from device`:**
   * **Causa:** Il Firewall di Windows blocca la connessione TCP di ritorno che l'ESP32 tenta di aprire verso il PC (`espota.exe`).
   * **Soluzione:** Aprire `wf.msc` (*Windows Defender Firewall con sicurezza avanzata*), entrare in **Regole connessioni in entrata**, eliminare eventuali regole di blocco rosse su `espota.exe` / `python.exe` e assicurarsi che il profilo della rete Wi-Fi sia impostato su **Rete Privata**.
2. **Avviso `Nessun monitor disponibile per il protocollo della porta network`:**
   * **Causa:** Dopo l'upload OTA (`100% Done...`), l'Arduino IDE tenta di aprire il Monitor Seriale sull'indirizzo IP `192.168.1.210`.
   * **Soluzione:** Non è un errore di caricamento. Tenere chiusa la scheda del Monitor Seriale quando è selezionata la porta di rete per evitare che l'IDE continui a inviare richieste TCP a vuoto verso l'ESP32.

---

## 6. Codice Sorgente Completo (`TerrarioController.ino`)
/**
 * @file TerrarioController.ino
 * @brief Centralina Terrario Bioattivo Definitiva (ESP32 Core 2.0.17)
 * Pinout: 
 *   - Striscia LED SK6812 RGBW: GPIO 4 (D4)
 *   - I2C Volta (Bus 0): SDA GPIO 21 (D21) | SCL GPIO 22 (D22)
 *   - I2C Tana  (Bus 1): SDA GPIO 18 (D18) | SCL GPIO 19 (D19)
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <Adafruit_NeoPixel.h>
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <ArduinoOTA.h>
#include <HTTPClient.h>
#include <time.h>
#include <sys/time.h>
#include <math.h>
#include "lwip/dns.h"

// ================= CONFIGURAZIONE RETE =================
const char* ssid = "IB24";
const char* password = "fuzzylotus067";

IPAddress local_IP(192, 168, 1, 210);
IPAddress gateway(192, 168, 1, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress primaryDNS(8, 8, 8, 8);
IPAddress secondaryDNS(1, 1, 1, 1);

// ================= FIREBASE RTDB =================
const char* FIREBASE_HOST = "terrario-bioattivo-default-rtdb.europe-west1.firebasedatabase.app";
const char* FIREBASE_SECRET = ""; // Lascia vuoto se le regole sono pubbliche (.write: true)

#define MAX_OFFLINE_READINGS 50
struct SensorRecord { time_t ts; float t1; float ur1; float t2; float ur2; };
SensorRecord offlineBuffer[MAX_OFFLINE_READINGS];
int offlineCount = 0;
unsigned long lastRetryTime = 0;
const unsigned long RETRY_INTERVAL = 60000;

// ================= STRISCIA LED & ENGINE GRAFICO =================
#define LED_PIN    4 // D4
#define NUM_LEDS   36
Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRBW + NEO_KHZ800);

uint8_t masterBrightness = 180;
uint8_t ledBuffer[NUM_LEDS][4];
uint8_t sparkleVal[NUM_LEDS];

volatile uint8_t animMode = 0;
volatile uint8_t animSpeed = 40;
volatile uint8_t animIntensity = 180;
volatile int8_t  animDir = 1;
volatile bool    ledsNeedUpdate = true;
volatile bool    isOtaUpdating = false;

float animPhase = 0.0f;
unsigned long lastAnimMillis = 0;

// ================= MOTORE CIRCADIANO =================
volatile bool autoMode = true;
volatile bool forceCircadianUpdate = true;
int currentSrMin = 450;  // Fallback 07:30
int currentSsMin = 1125; // Fallback 18:45
int currentNowMin = -1;
uint8_t currentSolarPhase = 0; // 0=Notte, 1=Alba, 2=Giorno, 3=Tramonto

// ================= TRIGGER TEST MANUALE SENSORI =================
volatile bool manualReadRequested = false;
volatile bool isReadingInProgress = false;
bool lastManualSendSuccess = false;
int lastFirebaseHttpCode = -99; // -99 = Mai eseguito
String lastFirebaseErrorStr = "In attesa";
String lastResolvedIP = "N/A";

// ================= SENSORI BME280 (DUE BUS I2C) =================
#define SDA_1 21
#define SCL_1 22
#define SDA_2 18
#define SCL_2 19

TwoWire I2Cone = TwoWire(0);
TwoWire I2Ctwo = TwoWire(1);
Adafruit_BME280 bme1; // Volta
Adafruit_BME280 bme2; // Tana
bool bme1_ok = false;
bool bme2_ok = false;

struct SensorData { float t = 0.0; float ur = 0.0; float p = 0.0; };
SensorData s1, s2;

// ================= ASYNC WEB SERVER =================
AsyncWebServer server(80);

const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Terrario Lazzate — LED Studio</title>
  <style>
    :root { --bg: #0b0f14; --card: #151c24; --card-border: #243040; --accent: #10b981; --accent-glow: rgba(16, 185, 129, 0.35); --warn: #f59e0b; --text: #f1f5f9; --muted: #94a3b8; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { background: radial-gradient(circle at top, #16222f 0%, var(--bg) 70%); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; padding: 16px; min-height: 100vh; }
    .container { max-width: 900px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding: 0 4px; }
    h1 { font-size: 1.35rem; margin: 0; background: linear-gradient(90deg, #34d399, #38bdf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .status-dot { font-size: 0.8rem; color: var(--muted); display: flex; align-items: center; gap: 6px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
    .card { background: var(--card); border: 1px solid var(--card-border); border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.4); }
    .card-title { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin: 0 0 14px 0; display: flex; justify-content: space-between; align-items: center; }
    
    .btn-auto { width: 100%; padding: 14px; font-size: 1.02rem; border-radius: 12px; background: #1e293b; color: var(--text); border: 1px solid #334155; cursor: pointer; transition: 0.2s; font-weight: bold; }
    .btn-auto.active { background: rgba(16, 185, 129, 0.15); border-color: var(--accent); color: #34d399; box-shadow: 0 0 15px var(--accent-glow); }
    .btn-auto.manual { background: rgba(245, 158, 11, 0.15); border-color: var(--warn); color: #fbbf24; }
    
    .solar-info { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 14px; font-size: 0.83rem; color: var(--muted); padding: 10px 12px; background: #0d131a; border-radius: 10px; border: 1px solid #1e293b; }
    .strip-wrapper { background: #070a0e; border: 1px solid #1e293b; border-radius: 14px; padding: 18px 12px; overflow-x: auto; touch-action: none; user-select: none; }
    .led-grid { display: grid; grid-template-columns: repeat(18, 1fr); gap: 8px; min-width: 520px; }
    .led-node { aspect-ratio: 1; border-radius: 50%; border: 2px solid #263244; background: #111; cursor: crosshair; position: relative; transition: transform 0.1s; display: flex; align-items: center; justify-content: center; font-size: 0.62rem; color: rgba(255,255,255,0.45); font-weight: 600; }
    .led-node:hover { transform: scale(1.18); border-color: #fff; z-index: 2; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; justify-content: center; }
    .btn { background: #1e293b; color: var(--text); border: 1px solid #334155; border-radius: 10px; padding: 8px 13px; font-size: 0.83rem; cursor: pointer; transition: all 0.15s ease; display: inline-flex; align-items: center; gap: 6px; }
    .btn:hover { background: #283548; border-color: #475569; }
    .btn.active { background: rgba(16, 185, 129, 0.18); border-color: var(--accent); color: #34d399; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    
    .color-studio { display: grid; grid-template-columns: 140px 1fr; gap: 18px; align-items: center; }
    @media (max-width: 600px) { .color-studio { grid-template-columns: 1fr; } }
    .color-preview-box { display: flex; flex-direction: column; align-items: center; gap: 10px; background: #0d131a; padding: 14px; border-radius: 12px; border: 1px solid #1e293b; }
    .color-swatch-main { width: 72px; height: 72px; border-radius: 50%; border: 3px solid #334155; position: relative; overflow: hidden; }
    .color-swatch-main input[type=color] { opacity: 0; width: 100%; height: 100%; cursor: pointer; position: absolute; top: 0; left: 0; }
    .sliders-col { display: flex; flex-direction: column; gap: 10px; }
    .slider-row { display: grid; grid-template-columns: 72px 1fr 42px; align-items: center; gap: 10px; font-size: 0.85rem; }
    input[type=range] { -webkit-appearance: none; width: 100%; height: 7px; border-radius: 5px; background: #0d131a; outline: none; border: 1px solid #263244; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fff; cursor: pointer; box-shadow: 0 0 6px rgba(0,0,0,0.6); }
    #slR { background: linear-gradient(90deg, #000, #ef4444); } #slG { background: linear-gradient(90deg, #000, #22c55e); } #slB { background: linear-gradient(90deg, #000, #3b82f6); } #slW { background: linear-gradient(90deg, #000, #fef08a); }
    
    .quick-palette { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid #1e293b; }
    .swatch { width: 28px; height: 28px; border-radius: 8px; cursor: pointer; border: 2px solid rgba(255,255,255,0.2); }
    .gradient-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; padding: 10px 12px; background: #0d131a; border-radius: 10px; border: 1px solid #1e293b; font-size: 0.82rem; }
    .mini-swatch { width: 26px; height: 26px; border-radius: 6px; border: 2px solid #475569; }
    .anim-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-bottom: 14px; }
    .preset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
    .preset-btn { padding: 12px; border-radius: 12px; border: 1px solid #2d3b4e; background: #18222f; color: #fff; font-weight: 600; font-size: 0.84rem; cursor: pointer; text-align: left; }
    .preset-btn:hover { border-color: var(--accent); }
    .preset-sub { display: block; font-size: 0.7rem; color: var(--muted); font-weight: 400; margin-top: 3px; }
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>🦎 Terrario Lazzate — LED Studio</h1>
    <div class="status-dot"><span class="dot"></span> <span id="lblClock">--:--</span></div>
  </header>

  <!-- MOTORE CIRCADIANO -->
  <div class="card">
    <div class="card-title">
      <span>🌍 Fotoperiodo Solare (Lazzate)</span>
      <span id="lblPhase" style="color:#38bdf8; font-weight:600;">Calcolo...</span>
    </div>
    <button id="btnAuto" class="btn-auto active" onclick="activateAuto()">✅ Ciclo Naturale Attivo (Premi per forzare ricalcolo)</button>
    <div class="solar-info">
      <span>🌅 Alba: <b id="lblSr" style="color:#fff;">--:--</b> <small>(-30m start)</small></span>
      <span>🌇 Tramonto: <b id="lblSs" style="color:#fff;">--:--</b> <small>(+30m buio)</small></span>
    </div>
  </div>

  <!-- SEZIONE TEST SENSORI IMMEDIATO -->
  <div class="card">
    <div class="card-title"><span>📡 Telemetria & Test Sensori</span></div>
    <button id="btnTestSensors" class="btn" style="width:100%; padding:12px; font-weight:600; font-size:0.92rem; justify-content:center;" onclick="triggerSensorTest()">
      🧪 Esegui Lettura Immediata & Invia a Firebase
    </button>
    <div id="testSensorResult" style="display:none; margin-top:12px; font-size:0.85rem; padding:10px; border-radius:8px; background:#0d131a; border:1px solid #1e293b; text-align:center;"></div>
  </div>

  <!-- MASTER DIMMER -->
  <div class="card">
    <div class="slider-row" style="grid-template-columns: 130px 1fr 45px;">
      <strong>☀️ Master Dimmer</strong>
      <input type="range" id="slDim" min="0" max="255" value="180" oninput="onDimmerInput(this.value)">
      <span id="valDim">180</span>
    </div>
  </div>

  <!-- MAPPA DEI LED -->
  <div class="card">
    <div class="card-title">
      <span>Mappa Striscia (36 LED RGBW)</span>
      <span id="activeToolLbl" style="color:var(--accent)">Pennello 1x</span>
    </div>
    <div class="strip-wrapper" id="stripArea"><div class="led-grid" id="ledGrid"></div></div>
    
    <div class="toolbar">
      <button class="btn active" id="toolBrush1" onclick="setTool('brush1')">🖌️ 1x</button>
      <button class="btn" id="toolBrush3" onclick="setTool('brush3')">✨ 3x</button>
      <button class="btn" id="toolPick" onclick="setTool('pick')">🧪 Copia</button>
      <button class="btn" id="toolErase" onclick="setTool('erase')">🧽 Gomma</button>
      <button class="btn" onclick="fillAll()">🪣 Riempi</button>
      <button class="btn" onclick="mirrorStrip()">🪞 Specchia</button>
      <button class="btn" onclick="clearAll()">🌑 Spegni</button>
    </div>

    <div class="gradient-bar">
      <span>🌈 <b>Gradiente:</b></span>
      <button class="btn" onclick="setGradEndpoint(0)">Fissa A</button>
      <div class="mini-swatch" id="gradSwatchA"></div>
      <span>➔</span>
      <button class="btn" onclick="setGradEndpoint(1)">Fissa B</button>
      <div class="mini-swatch" id="gradSwatchB"></div>
      <button class="btn active" onclick="applyGradient()">Applica A➔B</button>
    </div>
  </div>

  <!-- MISCELATORE COLORI -->
  <div class="card">
    <div class="card-title"><span>Miscelatore RGBW Hardware</span></div>
    <div class="color-studio">
      <div class="color-preview-box">
        <div class="color-swatch-main" id="mainSwatch"><input type="color" id="htmlColorPicker" value="#ff8800" oninput="onHtmlColorPick(this.value)"></div>
        <span style="font-size:0.72rem; color:var(--muted)">Ruota RGB</span>
      </div>
      <div class="sliders-col">
        <div class="slider-row"><span>🔴 R</span><input type="range" id="slR" min="0" max="255" value="255" oninput="onChannelChange()"><span id="valR">255</span></div>
        <div class="slider-row"><span>🟢 G</span><input type="range" id="slG" min="0" max="255" value="120" oninput="onChannelChange()"><span id="valG">120</span></div>
        <div class="slider-row"><span>🔵 B</span><input type="range" id="slB" min="0" max="255" value="0" oninput="onChannelChange()"><span id="valB">0</span></div>
        <div class="slider-row"><span>⚪ W</span><input type="range" id="slW" min="0" max="255" value="40" oninput="onChannelChange()"><span id="valW">40</span></div>
      </div>
    </div>
    <div class="quick-palette" id="quickPalette"></div>
  </div>

  <!-- DINAMICA MOVIMENTO -->
  <div class="card">
    <div class="card-title"><span>🌊 Movimento dei LED</span></div>
    <div class="anim-grid">
      <button class="btn active" id="anim0" onclick="setAnimMode(0)">⏸️ Statico</button>
      <button class="btn" id="anim1" onclick="setAnimMode(1)">🌊 Scorrimento</button>
      <button class="btn" id="anim2" onclick="setAnimMode(2)">↔️ Pendolo</button>
      <button class="btn" id="anim3" onclick="setAnimMode(3)">🫁 Respiro</button>
      <button class="btn" id="anim4" onclick="setAnimMode(4)">〰️ Onda</button>
      <button class="btn" id="anim5" onclick="setAnimMode(5)">✨ Lucciole</button>
    </div>
    <div class="sliders-col" style="margin-top: 12px;">
      <div class="slider-row" style="grid-template-columns: 120px 1fr 42px;"><span>⚡ Velocità</span><input type="range" id="slSpeed" min="1" max="100" value="35" oninput="onAnimParamChange()"><span id="valSpeed">35</span></div>
      <div class="slider-row" style="grid-template-columns: 120px 1fr 42px;"><span>🎚️ Profondità</span><input type="range" id="slInt" min="10" max="255" value="180" oninput="onAnimParamChange()"><span id="valInt">180</span></div>
      <div style="display:flex; gap:10px; align-items:center; margin-top:4px;">
        <span style="font-size:0.85rem;">Direzione:</span>
        <button class="btn active" id="dir1" onclick="setAnimDir(1)">➡️ Destra</button>
        <button class="btn" id="dir-1" onclick="setAnimDir(-1)">⬅️ Sinistra</button>
      </div>
    </div>
  </div>

  <!-- PRESET SCENOGRAFICI -->
  <div class="card">
    <div class="card-title"><span>🎨 Preset Scenografici Manuali</span></div>
    <div class="preset-grid">
      <button class="preset-btn" onclick="loadPreset('sunrise')" style="border-left: 4px solid #f97316;">🌅 Alba Tropicale<span class="preset-sub">Sfumatura oro-ambra + Onda</span></button>
      <button class="preset-btn" onclick="loadPreset('zenith')" style="border-left: 4px solid #fde047;">☀️ Zenith Solare<span class="preset-sub">Pieno spettro diurno caldo</span></button>
      <button class="preset-btn" onclick="loadPreset('sunset')" style="border-left: 4px solid #ef4444;">🌇 Tramonto Ambrato<span class="preset-sub">Rosso brace + Respiro</span></button>
      <button class="preset-btn" onclick="loadPreset('moon')" style="border-left: 4px solid #38bdf8;">🌙 Notte Lunare<span class="preset-sub">Blu profondo notturno</span></button>
      <button class="preset-btn" onclick="loadPreset('fireflies')" style="border-left: 4px solid #84cc16;">✨ Foresta Lucciole<span class="preset-sub">Muschio + Scintillio bio</span></button>
      <button class="preset-btn" onclick="loadPreset('aurora')" style="border-left: 4px solid #a855f7;">🌌 Aurora Boreale<span class="preset-sub">Smeraldo e viola in Flow</span></button>
    </div>
  </div>
</div>

<script>
  const NUM_LEDS = 36;
  let leds = Array.from({length: NUM_LEDS}, () => [0, 0, 0, 0]);
  let curColor = [255, 120, 0, 40];
  let gradA = [255, 60, 0, 0];
  let gradB = [255, 200, 0, 120];
  let currentTool = 'brush1';
  let isDrawing = false;
  let animMode = 0; let animDir = 1;
  let autoMode = true;
  let syncTimeout = null;
  let stateInterval = null;

  const quickColors = [
    [255,0,0,0], [255,90,0,0], [255,200,0,0], [0,255,0,0], [0,255,140,0], [0,180,255,0],
    [0,40,255,0], [160,0,255,0], [255,0,120,0], [0,0,0,255], [100,120,80,255], [0,0,0,35]
  ];

  function rgbwToCss(r, g, b, w) {
    return `rgb(${Math.min(255, Math.round(r + w * 0.95))}, ${Math.min(255, Math.round(g + w * 0.88))}, ${Math.min(255, Math.round(b + w * 0.72))})`;
  }

  function initUI() {
    const grid = document.getElementById('ledGrid');
    for (let i = 0; i < NUM_LEDS; i++) {
      const node = document.createElement('div');
      node.className = 'led-node'; node.id = 'led-' + i; node.innerText = i + 1;
      node.addEventListener('mousedown', () => { isDrawing = true; handleLedInteract(i); });
      node.addEventListener('mouseenter', () => { if (isDrawing) handleLedInteract(i); });
      grid.appendChild(node);
    }
    const stripArea = document.getElementById('stripArea');
    stripArea.addEventListener('touchstart', handleTouch, {passive: false});
    stripArea.addEventListener('touchmove', handleTouch, {passive: false});
    window.addEventListener('mouseup', () => isDrawing = false);
    window.addEventListener('touchend', () => isDrawing = false);

    const pal = document.getElementById('quickPalette');
    quickColors.forEach(c => {
      const sw = document.createElement('div'); sw.className = 'swatch';
      sw.style.background = rgbwToCss(c[0], c[1], c[2], c[3]);
      sw.onclick = () => setCurrentColor(c[0], c[1], c[2], c[3]);
      pal.appendChild(sw);
    });

    updateColorUI();
    updateGradSwatches();
    fetchCurrentState();
    stateInterval = setInterval(fetchCurrentState, 30000);
  }

  function handleTouch(e) {
    e.preventDefault();
    const el = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
    if (el && el.classList.contains('led-node')) handleLedInteract(parseInt(el.id.replace('led-', '')));
  }

  function setTool(t) {
    currentTool = t;
    ['brush1','brush3','pick','erase'].forEach(id => document.getElementById('tool' + id.charAt(0).toUpperCase() + id.slice(1)).classList.toggle('active', id === t));
  }

  function markManualModeUI() {
    autoMode = false;
    const btn = document.getElementById('btnAuto');
    btn.className = 'btn-auto manual';
    btn.innerText = "🖐️ Modalità Manuale — Premi qui per tornare al Ciclo Naturale";
  }

  function markAutoModeUI() {
    autoMode = true;
    const btn = document.getElementById('btnAuto');
    btn.className = 'btn-auto active';
    btn.innerText = "✅ Ciclo Naturale Attivo (Sincronizzato con Lazzate)";
  }

  function handleLedInteract(i) {
    if (currentTool === 'pick') { setCurrentColor(...leds[i]); setTool('brush1'); return; }
    markManualModeUI();
    if (currentTool === 'erase') leds[i] = [0, 0, 0, 0];
    else if (currentTool === 'brush1') leds[i] = [...curColor];
    else if (currentTool === 'brush3') { leds[i] = [...curColor]; if (i>0) blendLed(i-1, curColor, 0.5); if (i<35) blendLed(i+1, curColor, 0.5); }
    renderStripUI(); scheduleBulkSync();
  }

  function blendLed(idx, tgt, r) { for (let c=0; c<4; c++) leds[idx][c] = Math.round(leds[idx][c] * (1-r) + tgt[c]*r); }
  function renderStripUI() {
    for (let i = 0; i < NUM_LEDS; i++) {
      const [r, g, b, w] = leds[i];
      const el = document.getElementById('led-' + i);
      if (r+g+b+w === 0) { el.style.background = '#111'; el.style.boxShadow = 'none'; }
      else { const css = rgbwToCss(r, g, b, w); el.style.background = css; el.style.boxShadow = `0 0 12px ${css}`; }
    }
  }

  function setCurrentColor(r, g, b, w) { curColor = [r, g, b, w]; document.getElementById('slR').value = r; document.getElementById('slG').value = g; document.getElementById('slB').value = b; document.getElementById('slW').value = w; updateColorUI(); }
  function onChannelChange() { curColor = [parseInt(document.getElementById('slR').value), parseInt(document.getElementById('slG').value), parseInt(document.getElementById('slB').value), parseInt(document.getElementById('slW').value)]; updateColorUI(); }
  function onHtmlColorPick(hex) { setCurrentColor(parseInt(hex.substr(1,2),16), parseInt(hex.substr(3,2),16), parseInt(hex.substr(5,2),16), curColor[3]); }
  function updateColorUI() { document.getElementById('valR').innerText = curColor[0]; document.getElementById('valG').innerText = curColor[1]; document.getElementById('valB').innerText = curColor[2]; document.getElementById('valW').innerText = curColor[3]; document.getElementById('mainSwatch').style.background = rgbwToCss(...curColor); }

  function setGradEndpoint(w) { if (w===0) gradA = [...curColor]; else gradB = [...curColor]; updateGradSwatches(); }
  function updateGradSwatches() { document.getElementById('gradSwatchA').style.background = rgbwToCss(...gradA); document.getElementById('gradSwatchB').style.background = rgbwToCss(...gradB); }
  function applyGradient() {
    markManualModeUI();
    for (let i=0; i<NUM_LEDS; i++) {
      let t = i / (NUM_LEDS - 1);
      for (let c=0; c<4; c++) leds[i][c] = Math.round(gradA[c]*(1-t) + gradB[c]*t);
    }
    renderStripUI(); scheduleBulkSync(true);
  }

  function fillAll() { markManualModeUI(); for (let i=0; i<NUM_LEDS; i++) leds[i] = [...curColor]; renderStripUI(); scheduleBulkSync(true); }
  function clearAll() { markManualModeUI(); for (let i=0; i<NUM_LEDS; i++) leds[i] = [0, 0, 0, 0]; renderStripUI(); scheduleBulkSync(true); }
  function mirrorStrip() { markManualModeUI(); for (let i=0; i<18; i++) leds[35-i] = [...leds[i]]; renderStripUI(); scheduleBulkSync(true); }

  function scheduleBulkSync(immediate = false) {
    clearTimeout(syncTimeout);
    const sendFn = () => { fetch('/api/bulk?d=' + leds.map(c => c.map(v => v.toString(16).padStart(2,'0')).join('')).join('')).catch(()=>{}); };
    if (immediate) sendFn();
    else syncTimeout = setTimeout(sendFn, 50);
  }

  function onDimmerInput(val) { document.getElementById('valDim').innerText = val; fetch('/api/dimmer?val=' + val).catch(()=>{}); }
  
  function setAnimMode(m) { markManualModeUI(); animMode = m; for (let i=0; i<=5; i++) document.getElementById('anim'+i).classList.toggle('active', i===m); sendAnimParams(); }
  function setAnimDir(d) { markManualModeUI(); animDir = d; document.getElementById('dir1').classList.toggle('active', d===1); document.getElementById('dir-1').classList.toggle('active', d===-1); sendAnimParams(); }
  function onAnimParamChange() { markManualModeUI(); document.getElementById('valSpeed').innerText = document.getElementById('slSpeed').value; document.getElementById('valInt').innerText = document.getElementById('slInt').value; sendAnimParams(); }
  function sendAnimParams() { fetch(`/api/anim?mode=${animMode}&speed=${document.getElementById('slSpeed').value}&int=${document.getElementById('slInt').value}&dir=${animDir}`).catch(()=>{}); }

  function activateAuto() {
    clearTimeout(syncTimeout);
    markAutoModeUI();
    const browserTs = Math.floor(Date.now() / 1000);
    fetch(`/api/auto?val=1&ts=${browserTs}`)
      .then(r => r.json())
      .then(data => applyStateToUI(data))
      .catch(() => setTimeout(fetchCurrentState, 150));
  }

  function loadPreset(name) {
    markManualModeUI();
    for (let i = 0; i < NUM_LEDS; i++) {
      let t = i / (NUM_LEDS - 1);
      let centerDist = Math.abs(t - 0.5) * 2;
      if (name === 'sunrise') { leds[i] = [Math.round(220 + 35*(1-t)), Math.round(30 + 130*t), Math.round(40*(1-t)), Math.round(80*t*t)]; setAnimUI(4, 25, 140, 1); }
      else if (name === 'zenith') { let s = Math.max(0, 1 - centerDist*1.3); leds[i] = [Math.round(80 + 120*s), Math.round(140 + 80*s), 20, Math.round(60 + 195*s)]; setAnimUI(5, 20, 90, 1); }
      else if (name === 'sunset') { leds[i] = [Math.round(255*(1 - t*0.4)), Math.round(90*Math.pow(1-t, 1.5)), Math.round(80*t), Math.round(25*(1-t))]; setAnimUI(3, 20, 120, 1); }
      else if (name === 'moon') { let g = Math.max(0, 1 - centerDist*1.5); leds[i] = [0, Math.round(12 + 25*g), Math.round(35 + 65*g), Math.round(18*g)]; setAnimUI(0, 20, 100, 1); }
      else if (name === 'fireflies') { leds[i] = [Math.round(5 + (i%5===0?80:0)), Math.round(25 + (i%5===0?140:0)), 8, 0]; setAnimUI(5, 35, 220, 1); }
      else if (name === 'aurora') { let w = Math.sin(t * Math.PI * 2); leds[i] = [Math.round(90*Math.max(0, -w)), Math.round(200*Math.max(0, w) + 40), 160, 0]; setAnimUI(1, 30, 180, 1); }
    }
    renderStripUI();
    scheduleBulkSync(true);
    sendAnimParams();
  }

  function setAnimUI(m, sp, it, d) {
    animMode = m; animDir = d;
    document.getElementById('slSpeed').value = sp; document.getElementById('valSpeed').innerText = sp;
    document.getElementById('slInt').value = it; document.getElementById('valInt').innerText = it;
    for (let i=0; i<=5; i++) document.getElementById('anim'+i).classList.toggle('active', i===m);
    document.getElementById('dir1').classList.toggle('active', d===1);
    document.getElementById('dir-1').classList.toggle('active', d===-1);
  }

  // TEST SENSORI MANUALE CON SILENZIO RADIO DURANTE HANDSHAKE SSL
  function triggerSensorTest() {
    const btn = document.getElementById('btnTestSensors');
    const resBox = document.getElementById('testSensorResult');
    btn.disabled = true;
    btn.innerText = "⏳ Invio SSL in corso (attendere ~4s)...";
    resBox.style.display = "block";
    resBox.style.color = "#94a3b8";
    resBox.innerText = "Connessione TLS a Firebase in corso (nessuna richiesta web durante l'handshake)...";

    const browserTs = Math.floor(Date.now() / 1000);
    fetch(`/api/trigger_read?ts=${browserTs}`)
      .then(() => {
        // Aspettiamo 4.5 secondi senza disturbare l'ESP32 con richieste HTTP mentre fa l'handshake SSL!
        setTimeout(checkSensorStatus, 4500);
      })
      .catch(() => { btn.disabled = false; btn.innerText = "🧪 Esegui Lettura Immediata & Invia a Firebase"; });
  }

  function checkSensorStatus() {
    const btn = document.getElementById('btnTestSensors');
    const resBox = document.getElementById('testSensorResult');
    fetch('/api/sensor_status')
      .then(r => r.json())
      .then(data => {
        if (data.pending === 1) {
          setTimeout(checkSensorStatus, 1200);
          return;
        }
        btn.disabled = false;
        btn.innerText = "🧪 Esegui Lettura Immediata & Invia a Firebase";
        if (data.success) {
          resBox.style.color = "#34d399";
          resBox.innerHTML = `✅ <b>Inviato a Firebase (HTTP ${data.httpCode})!</b><br>Volta: <b>${data.t1.toFixed(1)}°C</b> / <b>${data.ur1.toFixed(1)}%</b> &nbsp;|&nbsp; Tana: <b>${data.t2.toFixed(1)}°C</b> / <b>${data.ur2.toFixed(1)}%</b><br><small style="color:#94a3b8">IP Firebase: ${data.fbIP} | RAM Libera: ${data.heap} B</small>`;
        } else {
          resBox.style.color = "#f87171";
          resBox.innerHTML = `⚠️ <b>Errore Firebase (HTTP ${data.httpCode}: ${data.err})</b><br>Volta: <b>${data.t1.toFixed(1)}°C</b> / <b>${data.ur1.toFixed(1)}%</b> &nbsp;|&nbsp; Tana: <b>${data.t2.toFixed(1)}°C</b> / <b>${data.ur2.toFixed(1)}%</b><br><small style="color:#cbd5e1">DNS: ${data.dns} | IP Firebase: ${data.fbIP} | Heap: ${data.heap} B</small>`;
        }
      })
      .catch(() => { btn.disabled = false; btn.innerText = "🧪 Esegui Lettura Immediata & Invia a Firebase"; });
  }

  function formatTime(min) {
    if (min < 0) return "--:--";
    return String(Math.floor(min/60)).padStart(2,'0') + ':' + String(min%60).padStart(2,'0');
  }

  function applyStateToUI(data) {
    document.getElementById('slDim').value = data.dim;
    document.getElementById('valDim').innerText = data.dim;
    setAnimUI(data.mode, data.speed, data.int, data.dir || 1);
    
    if (data.auto === 1) markAutoModeUI();
    else markManualModeUI();
    
    document.getElementById('lblSr').innerText = formatTime(data.sr);
    document.getElementById('lblSs').innerText = formatTime(data.ss);
    document.getElementById('lblClock').innerText = "Ora ESP32: " + formatTime(data.nowMin);

    const phases = ["🌙 Fase: Notte (Luci Spente)", "🌅 Fase: Transizione Alba", "☀️ Fase: Giorno (Bianco Naturale)", "🌇 Fase: Transizione Tramonto"];
    document.getElementById('lblPhase').innerText = phases[data.phase] || "";

    if (data.leds && data.leds.length === NUM_LEDS * 8) {
      for (let i = 0; i < NUM_LEDS; i++) {
        const sub = data.leds.substr(i*8, 8);
        leds[i] = [parseInt(sub.substr(0,2),16), parseInt(sub.substr(2,2),16), parseInt(sub.substr(4,2),16), parseInt(sub.substr(6,2),16)];
      }
      renderStripUI();
    }
  }

  function fetchCurrentState() {
    const browserTs = Math.floor(Date.now() / 1000);
    fetch(`/api/state?ts=${browserTs}`).then(r => r.json()).then(data => applyStateToUI(data)).catch(()=>{});
  }

  window.onload = initUI;
</script>
</body>
</html>
)rawliteral";

// ================= MOTORE GRAFICO LED =================
uint8_t hexCharToVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}
uint8_t hexPairToByte(char c1, char c2) { return (hexCharToVal(c1) << 4) | hexCharToVal(c2); }

void updateLedEngine() {
  if (isOtaUpdating) return;

  unsigned long now = millis();
  if (animMode == 0 && !ledsNeedUpdate) return;
  if (animMode != 0 && (now - lastAnimMillis < 20) && !ledsNeedUpdate) return;

  float dt = (now - lastAnimMillis) / 1000.0f;
  if (dt > 0.2f) dt = 0.02f;
  lastAnimMillis = now;
  ledsNeedUpdate = false;

  float speedFactor = (animSpeed / 100.0f) * 8.0f + 0.15f;
  animPhase += dt * speedFactor;
  if (animPhase > 10000.0f) animPhase -= 10000.0f;

  float dimScale = masterBrightness / 255.0f;
  float intNorm = animIntensity / 255.0f;

  for (int i = 0; i < NUM_LEDS; i++) {
    float r = ledBuffer[i][0], g = ledBuffer[i][1], b = ledBuffer[i][2], w = ledBuffer[i][3];

    if (animMode == 1 || animMode == 2) {
      float shift = (animMode == 1) ? (animPhase * (-animDir)) : (sinf(animPhase) * (NUM_LEDS * 0.35f * intNorm));
      float vPos = fmodf((float)i + shift, (float)NUM_LEDS);
      if (vPos < 0.0f) vPos += NUM_LEDS;
      int idx0 = (int)vPos; int idx1 = (idx0 + 1) % NUM_LEDS; float frac = vPos - idx0;
      r = ledBuffer[idx0][0]*(1-frac) + ledBuffer[idx1][0]*frac;
      g = ledBuffer[idx0][1]*(1-frac) + ledBuffer[idx1][1]*frac;
      b = ledBuffer[idx0][2]*(1-frac) + ledBuffer[idx1][2]*frac;
      w = ledBuffer[idx0][3]*(1-frac) + ledBuffer[idx1][3]*frac;
    } else if (animMode == 3) {
      float factor = 1.0f - (intNorm * 0.85f * (1.0f - (sinf(animPhase * 1.5f) + 1.0f) * 0.5f));
      r *= factor; g *= factor; b *= factor; w *= factor;
    } else if (animMode == 4) {
      float factor = 1.0f - (intNorm * 0.8f * (1.0f - (sinf(animPhase * 2.0f * (-animDir) + (i * 0.35f)) + 1.0f) * 0.5f));
      r *= factor; g *= factor; b *= factor; w *= factor;
    } else if (animMode == 5) {
      if (sparkleVal[i] > 4) sparkleVal[i] -= 4; else sparkleVal[i] = 0;
      if (random(0, 1000) < (animSpeed / 3 + 2)) sparkleVal[i] = 255;
      float sp = (sparkleVal[i] / 255.0f) * intNorm;
      r = min(255.0f, r + sp * 180.0f); g = min(255.0f, g + sp * 220.0f); w = min(255.0f, w + sp * 200.0f);
    }
    
    strip.setPixelColor(i, strip.Color((uint8_t)constrain(r * dimScale, 0, 255), (uint8_t)constrain(g * dimScale, 0, 255), (uint8_t)constrain(b * dimScale, 0, 255), (uint8_t)constrain(w * dimScale, 0, 255)));
  }
  strip.show();
}

// ================= CALCOLATORE ASTRONOMICO LAZZATE =================
void getSolarTimes(struct tm* timeinfo, int &srMin, int &ssMin) {
  float lat = 45.674; // Lazzate
  float lon = 9.082;
  
  float declination = -23.44 * cos((360.0 / 365.24) * (timeinfo->tm_yday + 10) * PI / 180.0);
  float radLat = lat * PI / 180.0;
  float radDec = declination * PI / 180.0;
  float cosH = (sin(-0.83 * PI / 180.0) - sin(radLat) * sin(radDec)) / (cos(radLat) * cos(radDec));
  cosH = constrain(cosH, -1.0, 1.0);
  
  float h = acos(cosH) * 180.0 / PI;
  float halfDay = h / 15.0;
  
  float solarNoonUTC = 12.0 - (lon / 15.0);
  float srUTC = solarNoonUTC - halfDay;
  float ssUTC = solarNoonUTC + halfDay;

  int utcOffset = 1 + (timeinfo->tm_isdst > 0 ? 1 : 0);
  
  srMin = round((srUTC + utcOffset) * 60.0);
  ssMin = round((ssUTC + utcOffset) * 60.0);
}

void applyAutoCircadian(int cur, int sr, int ss) {
  float t;
  uint8_t R = 0, G = 0, B = 0, W = 0;
  
  uint8_t day[4]  = {100, 120, 80, 255};
  uint8_t dawn[4] = {255, 60, 0, 10};

  if (cur < sr - 30 || cur >= ss + 30) {
    R = 0; G = 0; B = 0; W = 0;
    currentSolarPhase = 0;
  }
  else if (cur >= sr - 30 && cur < sr + 30) {
    currentSolarPhase = 1;
    t = (cur - (sr - 30)) / 60.0f;
    if (t < 0.5f) {
      float t2 = t * 2.0f;
      R = dawn[0] * t2; G = dawn[1] * t2; B = dawn[2] * t2; W = dawn[3] * t2;
    } else {
      float t2 = (t - 0.5f) * 2.0f;
      R = dawn[0] + (day[0] - dawn[0]) * t2;
      G = dawn[1] + (day[1] - dawn[1]) * t2;
      B = dawn[2] + (day[2] - dawn[2]) * t2;
      W = dawn[3] + (day[3] - dawn[3]) * t2;
    }
  }
  else if (cur >= sr + 30 && cur < ss - 30) {
    currentSolarPhase = 2;
    R = day[0]; G = day[1]; B = day[2]; W = day[3];
  }
  else if (cur >= ss - 30 && cur < ss + 30) {
    currentSolarPhase = 3;
    t = (cur - (ss - 30)) / 60.0f;
    if (t < 0.5f) {
      float t2 = t * 2.0f;
      R = day[0] + (dawn[0] - day[0]) * t2;
      G = day[1] + (dawn[1] - day[1]) * t2;
      B = day[2] + (dawn[2] - day[2]) * t2;
      W = day[3] + (dawn[3] - day[3]) * t2;
    } else {
      float t2 = (t - 0.5f) * 2.0f;
      R = dawn[0] * (1.0f - t2);
      G = dawn[1] * (1.0f - t2);
      B = dawn[2] * (1.0f - t2);
      W = dawn[3] * (1.0f - t2);
    }
  }

  animMode = 0;
  for (int i = 0; i < NUM_LEDS; i++) {
     ledBuffer[i][0] = R; ledBuffer[i][1] = G; ledBuffer[i][2] = B; ledBuffer[i][3] = W;
  }
  ledsNeedUpdate = true;
}

void runCircadianStep() {
  time_t ts = time(nullptr);
  if (ts > 1000000000) {
    struct tm timeinfo;
    localtime_r(&ts, &timeinfo);
    currentNowMin = timeinfo.tm_hour * 60 + timeinfo.tm_min;
    getSolarTimes(&timeinfo, currentSrMin, currentSsMin);
    if (autoMode) {
      applyAutoCircadian(currentNowMin, currentSrMin, currentSsMin);
    }
  }
}

void syncClockFromBrowserIfNeeded(AsyncWebServerRequest *request) {
  if (request->hasParam("ts")) {
    time_t now = time(nullptr);
    if (now < 1000000000) {
      time_t browserTs = (time_t)request->getParam("ts")->value().toInt();
      if (browserTs > 1700000000) {
        struct timeval tv = { .tv_sec = browserTs, .tv_usec = 0 };
        settimeofday(&tv, NULL);
        runCircadianStep();
      }
    }
  }
}

String buildStateJson() {
  char hexBuf[NUM_LEDS * 8 + 1];
  for (int i = 0; i < NUM_LEDS; i++) {
    sprintf(&hexBuf[i * 8], "%02x%02x%02x%02x", ledBuffer[i][0], ledBuffer[i][1], ledBuffer[i][2], ledBuffer[i][3]);
  }
  hexBuf[NUM_LEDS * 8] = '\0';
  String json = "{";
  json += "\"dim\":" + String(masterBrightness) + ",";
  json += "\"mode\":" + String(animMode) + ",";
  json += "\"speed\":" + String(animSpeed) + ",";
  json += "\"int\":" + String(animIntensity) + ",";
  json += "\"dir\":" + String(animDir) + ",";
  json += "\"auto\":" + String(autoMode ? 1 : 0) + ",";
  json += "\"sr\":" + String(currentSrMin) + ",";
  json += "\"ss\":" + String(currentSsMin) + ",";
  json += "\"nowMin\":" + String(currentNowMin) + ",";
  json += "\"phase\":" + String(currentSolarPhase) + ",";
  json += "\"leds\":\"" + String(hexBuf) + "\"";
  json += "}";
  return json;
}

// ================= HARDWARE / SENSORI & FIREBASE HTTPS =================
void readSensors() {
  if (bme1_ok) { s1.t = bme1.readTemperature(); s1.ur = bme1.readHumidity(); }
  if (bme2_ok) { s2.t = bme2.readTemperature(); s2.ur = bme2.readHumidity(); }
}

void forceDnsServers() {
  ip_addr_t d1, d2;
  IP_ADDR4(&d1, 8, 8, 8, 8);
  IP_ADDR4(&d2, 1, 1, 1, 1);
  dns_setserver(0, &d1);
  dns_setserver(1, &d2);
}

bool sendToFirebase(time_t ts, float t1, float ur1, float t2, float ur2) {
  if (WiFi.status() != WL_CONNECTED) {
    lastFirebaseHttpCode = -10;
    lastFirebaseErrorStr = "WiFi Disconnesso";
    return false;
  }

  // Forza DNS LwIP nel caso WiFi.config li avesse persi
  forceDnsServers();

  // Test risoluzione DNS prima di aprire il socket SSL
  IPAddress resolved;
  if (!WiFi.hostByName(FIREBASE_HOST, resolved)) {
    lastResolvedIP = "DNS_FAIL";
    lastFirebaseHttpCode = -11;
    lastFirebaseErrorStr = "Errore DNS (Router non raggiunge Internet)";
    return false;
  }
  lastResolvedIP = resolved.toString();

  if (ts < 1000000000) ts = millis() / 1000;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(12);

  HTTPClient http;
  http.setConnectTimeout(10000);
  http.setTimeout(10000);

  String path = "/telemetria/" + String((unsigned long)ts) + ".json";
  if (String(FIREBASE_SECRET).length() > 0) {
    path += "?auth=" + String(FIREBASE_SECRET);
  }

  if (!http.begin(client, FIREBASE_HOST, 443, path, true)) {
    lastFirebaseHttpCode = -12;
    lastFirebaseErrorStr = "Init HTTPS Fallito";
    return false;
  }

  http.addHeader("Content-Type", "application/json");

  String payload = "{\"timestamp\":" + String((unsigned long)ts) +
                   ",\"volta_t\":" + String(t1, 2) +
                   ",\"volta_ur\":" + String(ur1, 2) +
                   ",\"tana_t\":" + String(t2, 2) +
                   ",\"tana_ur\":" + String(ur2, 2) + "}";

  lastFirebaseHttpCode = http.PUT(payload);
  if (lastFirebaseHttpCode <= 0) {
    lastFirebaseErrorStr = http.errorToString(lastFirebaseHttpCode);
  } else if (lastFirebaseHttpCode == 401 || lastFirebaseHttpCode == 403) {
    lastFirebaseErrorStr = "Permesso Negato (Controlla Regole Firebase .write: true)";
  } else {
    lastFirebaseErrorStr = "OK";
  }
  
  http.end();
  return (lastFirebaseHttpCode == 200 || lastFirebaseHttpCode == 201);
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200); delay(500);

  strip.begin(); strip.setBrightness(255);
  for (int i = 0; i < NUM_LEDS; i++) { ledBuffer[i][0]=0; ledBuffer[i][1]=0; ledBuffer[i][2]=0; ledBuffer[i][3]=0; }
  ledsNeedUpdate = true; updateLedEngine();

  I2Cone.begin(SDA_1, SCL_1);
  I2Ctwo.begin(SDA_2, SCL_2);
  bme1_ok = bme1.begin(0x76, &I2Cone) || bme1.begin(0x77, &I2Cone);
  bme2_ok = bme2.begin(0x76, &I2Ctwo) || bme2.begin(0x77, &I2Ctwo);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  
  WiFi.setSleep(false);
  forceDnsServers();

  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.nist.gov");
  setenv("TZ", "CET-1CEST,M3.5.0,M10.5.0/3", 1);
  tzset();

  ArduinoOTA.setHostname("Terrario-Lazzate");
  ArduinoOTA.onStart([]() {
    isOtaUpdating = true;
    server.end();
    strip.clear();
    strip.show();
  });
  ArduinoOTA.onEnd([]() { isOtaUpdating = false; });
  ArduinoOTA.onError([](ota_error_t error) { isOtaUpdating = false; ESP.restart(); });
  ArduinoOTA.begin();

  readSensors();

  // Rotte Web Server
  server.on("/", HTTP_GET, [](AsyncWebServerRequest *request){
    request->send_P(200, "text/html", index_html);
  });

  server.on("/api/state", HTTP_GET, [](AsyncWebServerRequest *request){
    syncClockFromBrowserIfNeeded(request);
    runCircadianStep();
    request->send(200, "application/json", buildStateJson());
  });

  server.on("/api/auto", HTTP_GET, [](AsyncWebServerRequest *request){
    syncClockFromBrowserIfNeeded(request);
    if (request->hasParam("val")) {
      autoMode = (request->getParam("val")->value() == "1");
      if (autoMode) {
        animMode = 0;
        forceCircadianUpdate = true;
        runCircadianStep();
      }
    }
    request->send(200, "application/json", buildStateJson());
  });

  server.on("/api/trigger_read", HTTP_GET, [](AsyncWebServerRequest *request){
    syncClockFromBrowserIfNeeded(request);
    lastFirebaseHttpCode = -99; // Reset stato
    isReadingInProgress = true;
    manualReadRequested = true;
    request->send(200, "text/plain", "OK");
  });

  server.on("/api/sensor_status", HTTP_GET, [](AsyncWebServerRequest *request){
    String json = "{";
    json += "\"pending\":" + String(isReadingInProgress ? 1 : 0) + ",";
    json += "\"success\":" + String(lastManualSendSuccess ? 1 : 0) + ",";
    json += "\"httpCode\":" + String(lastFirebaseHttpCode) + ",";
    json += "\"err\":\"" + lastFirebaseErrorStr + "\",";
    json += "\"dns\":\"" + WiFi.dnsIP(0).toString() + "\",";
    json += "\"fbIP\":\"" + lastResolvedIP + "\",";
    json += "\"heap\":" + String(ESP.getFreeHeap()) + ",";
    json += "\"t1\":" + String(s1.t, 2) + ",";
    json += "\"ur1\":" + String(s1.ur, 2) + ",";
    json += "\"t2\":" + String(s2.t, 2) + ",";
    json += "\"ur2\":" + String(s2.ur, 2);
    json += "}";
    request->send(200, "application/json", json);
  });

  server.on("/api/bulk", HTTP_GET, [](AsyncWebServerRequest *request){
    autoMode = false;
    if (request->hasParam("d")) {
      String d = request->getParam("d")->value();
      if (d.length() == NUM_LEDS * 8) {
        for (int i = 0; i < NUM_LEDS; i++) {
          int b = i * 8;
          ledBuffer[i][0] = hexPairToByte(d[b], d[b+1]); ledBuffer[i][1] = hexPairToByte(d[b+2], d[b+3]);
          ledBuffer[i][2] = hexPairToByte(d[b+4], d[b+5]); ledBuffer[i][3] = hexPairToByte(d[b+6], d[b+7]);
        }
        ledsNeedUpdate = true;
      }
    }
    request->send(200, "text/plain", "OK");
  });

  server.on("/api/dimmer", HTTP_GET, [](AsyncWebServerRequest *request){
    if (request->hasParam("val")) { masterBrightness = (uint8_t)constrain(request->getParam("val")->value().toInt(), 0, 255); ledsNeedUpdate = true; }
    request->send(200, "text/plain", "OK");
  });

  server.on("/api/anim", HTTP_GET, [](AsyncWebServerRequest *request){
    autoMode = false;
    if (request->hasParam("mode"))  animMode = (uint8_t)constrain(request->getParam("mode")->value().toInt(), 0, 5);
    if (request->hasParam("speed")) animSpeed = (uint8_t)constrain(request->getParam("speed")->value().toInt(), 1, 100);
    if (request->hasParam("int"))   animIntensity = (uint8_t)constrain(request->getParam("int")->value().toInt(), 0, 255);
    if (request->hasParam("dir"))   animDir = (request->getParam("dir")->value().toInt() < 0) ? -1 : 1;
    ledsNeedUpdate = true; request->send(200, "text/plain", "OK");
  });

  server.begin();
}

// ================= LOOP PRINCIPALE =================
void loop() {
  ArduinoOTA.handle();

  if (isOtaUpdating) {
    delay(5);
    return;
  }

  updateLedEngine();

  unsigned long currentMillis = millis();
  time_t ts = time(nullptr);
  static int lastUploadedMinute = -1;
  static int lastCircadianMin = -1;

  // 1. GESTIONE RILEVAZIONE DI TEST RICHIESTA DAL WEB
  if (manualReadRequested) {
    manualReadRequested = false;
    readSensors();
    time_t nowTs = time(nullptr);
    lastManualSendSuccess = sendToFirebase(nowTs, s1.t, s1.ur, s2.t, s2.ur);
    isReadingInProgress = false;
    if (!lastManualSendSuccess) {
      if (offlineCount < MAX_OFFLINE_READINGS) {
        offlineBuffer[offlineCount] = {nowTs, s1.t, s1.ur, s2.t, s2.ur};
        offlineCount++;
      }
    }
  }

  // 2. SCHEDULAZIONE ORARIA (CICLO SOLARE + TELEMETRIA AI MINUTI 15 E 45)
  if (ts > 1000000000) {
    struct tm timeinfo;
    localtime_r(&ts, &timeinfo);
    int currentMinute = timeinfo.tm_min;
    int absMinute = timeinfo.tm_hour * 60 + currentMinute;
    currentNowMin = absMinute;

    if (autoMode && (absMinute != lastCircadianMin || forceCircadianUpdate)) {
      lastCircadianMin = absMinute;
      forceCircadianUpdate = false;
      getSolarTimes(&timeinfo, currentSrMin, currentSsMin);
      applyAutoCircadian(absMinute, currentSrMin, currentSsMin);
    }

    if ((currentMinute == 15 || currentMinute == 45) && currentMinute != lastUploadedMinute) {
      lastUploadedMinute = currentMinute;
      readSensors();
      if (!sendToFirebase(ts, s1.t, s1.ur, s2.t, s2.ur)) {
        if (offlineCount < MAX_OFFLINE_READINGS) {
          offlineBuffer[offlineCount] = {ts, s1.t, s1.ur, s2.t, s2.ur};
          offlineCount++;
        }
      }
    }
  }

  // 3. SMALTIMENTO BUFFER OFFLINE FIREBASE
  if (offlineCount > 0 && WiFi.status() == WL_CONNECTED && currentMillis - lastRetryTime >= RETRY_INTERVAL) {
    lastRetryTime = currentMillis;
    int idx = offlineCount - 1;
    if (sendToFirebase(offlineBuffer[idx].ts, offlineBuffer[idx].t1, offlineBuffer[idx].ur1, offlineBuffer[idx].t2, offlineBuffer[idx].ur2)) {
      offlineCount--;
    }
  }

  delay(2);
}
